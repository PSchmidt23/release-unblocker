/**
 * Trigger → classify → agent → gates → outcome.
 * This file is the walkthrough. It does not import @cursor/sdk.
 */
import type { AppConfig } from "./config.js";
import { classify, emptyEvidence } from "./classifier.js";
import { buildDiagnosisPrompt, buildFixPrompt, buildShrinkPrompt } from "./prompt.js";
import { canAskForSmallerDiff, evaluateGates, failedReasons } from "./gates.js";
import { runReleaseAgent } from "./agent.js";
import type { AgentClient, AgentHooks, AgentRequest } from "./agent-request.js";
import { summarizeIncident, summaryToMarkdown } from "./summarize.js";
import { IncidentMachine } from "./state.js";
import { nowIso, type AuditLog } from "./audit.js";
import { dedupeKeys, IdempotencyStore, newIncidentId } from "./idempotency.js";
import { agentDetail, findIncident } from "./incidents.js";
import type { GitHubClient } from "./github.js";
import type { EventHub } from "./hub.js";
import {
  isTerminal,
  type AgentResult,
  type AuditRecord,
  type CiEvidence,
  type Classification,
  type ClassifyInput,
  type GateInput,
  type GateReport,
  type IncidentState,
  type IncidentSummary,
  type IncidentView,
  type InboundIncident,
} from "./types.js";

export interface Runtime {
  config: AppConfig;
  audit: AuditLog;
  idempotency: IdempotencyStore;
  github: GitHubClient;
  hub: EventHub;
}

export interface RunOptions {
  dryRun: boolean;
  mockBehavior?: AgentRequest["mockBehavior"];
  agent?: typeof runReleaseAgent;
  /** Injected SDK client. Ignored on the dry-run path. */
  client?: AgentClient;
}

export function createRuntime(config: AppConfig, github: GitHubClient, audit: AuditLog, hub: EventHub): Runtime {
  return {
    config,
    audit,
    idempotency: new IdempotencyStore(audit.readAll()),
    github,
    hub,
  };
}

export function acceptIncident(runtime: Runtime, inbound: InboundIncident): { duplicate: boolean; incidentId: string } {
  const resolved = withRepo(runtime, inbound);
  const keys = dedupeKeys(resolved);
  const existing = runtime.idempotency.find(keys);
  if (existing) return { duplicate: true, incidentId: existing };
  const incidentId = newIncidentId();
  append(runtime, {
    v: 1,
    ts: nowIso(),
    incidentId,
    state: "RECEIVED",
    type: "transition",
    dedupeKeys: keys,
    detail: {
      source: resolved.kind,
      title: resolved.title,
      repoUrl: resolved.repoUrl,
      branch: resolved.branch,
      sha: resolved.sha,
      runId: resolved.runId,
      findingId: resolved.finding?.id,
    },
  });
  runtime.idempotency.remember(keys, incidentId);
  return { duplicate: false, incidentId };
}

export async function runIncident(
  runtime: Runtime,
  incidentId: string,
  inbound: InboundIncident,
  options: RunOptions,
): Promise<IncidentView> {
  const resolved = withRepo(runtime, inbound);
  const machine = new IncidentMachine("RECEIVED");
  const agent = options.agent ?? runReleaseAgent;

  const move = (to: IncidentState, detail?: Record<string, unknown>): void => {
    machine.transition(to);
    append(runtime, {
      v: 1,
      ts: nowIso(),
      incidentId,
      state: to,
      type: "transition",
      detail,
    });
    console.log(`[release-unblocker] ${incidentId} ${to}`);
  };

  const hooks = (): AgentHooks => ({
    onStream(event) {
      append(runtime, {
        v: 1,
        ts: nowIso(),
        incidentId,
        state: machine.state,
        type: "agent_event",
        detail: { kind: event.kind, text: event.text },
      });
    },
  });

  try {
    const { evidence, evidenceNote } = await loadEvidence(runtime, resolved);
    const classifyInput: ClassifyInput = {
      source: resolved.kind,
      repoUrl: resolved.repoUrl,
      branch: resolved.branch,
      sha: resolved.sha,
      workflowName: resolved.workflowName,
      evidence,
      finding: resolved.finding,
    };
    const classification = classify(classifyInput);
    move("CLASSIFIED", {
      classification,
      evidenceNote,
      source: resolved.kind,
      title: resolved.title,
      repoUrl: resolved.repoUrl,
      branch: resolved.branch,
      sha: resolved.sha,
    });

    const startingRef = resolved.sha ?? resolved.branch;
    if (!startingRef || startingRef === "unknown") {
      throw new Error("No branch or SHA to start the agent from.");
    }

    const writing = classification.policy !== "escalate_human";
    const mode = writing ? "agent" : "plan";
    const baseRequest: Omit<AgentRequest, "prompt" | "attempt" | "idempotencyKey" | "resumeAgentId"> = {
      incidentId,
      dryRun: options.dryRun,
      apiKey: runtime.config.cursorApiKey,
      modelId: runtime.config.cursorModel,
      mode,
      repoUrl: resolved.repoUrl,
      startingRef,
      branchName: resolved.branch,
      autoCreatePR: classification.policy === "open_fix_pr",
      workOnCurrentBranch: classification.policy === "auto_fix_branch",
      category: classification.category,
      mockBehavior: options.mockBehavior,
      streamDelayMs: runtime.config.mockStreamDelayMs,
    };

    const launch = (attempt: number, prompt: string, resumeAgentId?: string) => {
      const request: AgentRequest = {
        ...baseRequest,
        attempt,
        prompt,
        resumeAgentId,
        idempotencyKey: `ru:${incidentId}:${attempt}`,
      };
      return agent(request, hooks(), options.client);
    };

    let attempt = 1;
    move("AGENT_RUNNING", { attempt, mode, dryRun: options.dryRun });
    let result = await launch(
      attempt,
      writing ? buildFixPrompt(classifyInput, classification) : buildDiagnosisPrompt(classifyInput, classification),
    );
    if (result.status !== "finished") {
      await close(runtime, move, "FAILED", {
        error: result.error ?? `Agent run ended ${result.status}.`,
        agent: agentDetail(result, attempt),
        classification,
        resolved,
        result,
        gateText: undefined,
      });
      return mustView(runtime, incidentId);
    }

    if (!writing) {
      await closeDiagnosis(runtime, move, resolved, classification, result);
      return mustView(runtime, incidentId);
    }

    let report = await recordGates(runtime, move, resolved, result, baseRequest.workOnCurrentBranch, attempt);
    if (!report.passed && canAskForSmallerDiff(report)) {
      attempt = 2;
      move("AGENT_RUNNING", { attempt, mode, dryRun: options.dryRun, resumeAgentId: result.agentId });
      result = await launch(attempt, buildShrinkPrompt(report), result.agentId);
      if (result.status !== "finished") {
        await close(runtime, move, "FAILED", {
          error: result.error ?? `Follow-up run ended ${result.status}.`,
          agent: agentDetail(result, attempt),
          classification,
          resolved,
          result,
          gateText: failedReasons(report).join(" "),
        });
        return mustView(runtime, incidentId);
      }
      report = await recordGates(runtime, move, resolved, result, baseRequest.workOnCurrentBranch, attempt);
    }

    const promoted =
      report.passed && classification.policy === "auto_fix_branch"
        ? "AUTO_FIXED"
        : report.passed && classification.policy === "open_fix_pr"
          ? "PR_OPEN"
          : "ESCALATED";
    await close(runtime, move, promoted, {
      reasons: promoted === "ESCALATED" ? failedReasons(report) : [],
      agent: agentDetail(result, attempt),
      classification,
      resolved,
      result,
      gateText: report.checks.map((check) => `${check.passed ? "pass" : "fail"}: ${check.reason}`).join(" "),
    });
    return mustView(runtime, incidentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[release-unblocker] ${incidentId} error: ${message}`);
    if (!isTerminal(machine.state)) {
      move("FAILED", { error: message });
    }
    return mustView(runtime, incidentId);
  }
}

async function closeDiagnosis(
  runtime: Runtime,
  move: (to: IncidentState, detail?: Record<string, unknown>) => void,
  inbound: InboundIncident,
  classification: Classification,
  result: AgentResult,
): Promise<void> {
  const input = await loadGateInput(runtime, inbound, result, false);
  const reasons = [...classification.reasons];
  if (input.files.length > 0) {
    const report = evaluateGates(input);
    move("GATES", { gate: report, attempt: 1, agent: agentDetail(result, 1) });
    reasons.push("Diagnosis run produced a diff. Promotion is refused.");
    reasons.push(...failedReasons(report));
  }
  await close(runtime, move, "ESCALATED", {
    reasons,
    agent: agentDetail(result, 1),
    classification,
    resolved: inbound,
    result,
    gateText: input.files.length === 0 ? "Gates skipped: diagnosis only, no diff." : undefined,
  });
}

async function recordGates(
  runtime: Runtime,
  move: (to: IncidentState, detail?: Record<string, unknown>) => void,
  inbound: InboundIncident,
  result: AgentResult,
  workOnCurrentBranch: boolean,
  attempt: number,
): Promise<GateReport> {
  const input = await loadGateInput(runtime, inbound, result, workOnCurrentBranch);
  const report = evaluateGates(input);
  move("GATES", { gate: report, attempt, agent: agentDetail(result, attempt) });
  return report;
}

async function close(
  runtime: Runtime,
  move: (to: IncidentState, detail?: Record<string, unknown>) => void,
  state: IncidentState,
  context: {
    reasons?: string[];
    error?: string;
    agent?: Record<string, unknown>;
    classification?: Classification;
    resolved: InboundIncident;
    result?: AgentResult;
    gateText?: string;
  },
): Promise<void> {
  const reasons = context.reasons ?? [];
  const summary = await summarizeIncident(
    {
      state,
      category: context.classification?.category,
      risk: context.classification?.risk,
      policy: context.classification?.policy,
      branch: context.resolved.branch,
      title: context.resolved.title,
      reasons: reasons.length ? reasons : (context.classification?.reasons ?? []),
      agentText: context.result?.text,
      gateResults: context.gateText,
      protectedPaths: context.classification?.protectedPaths,
    },
    { apiKey: runtime.config.xaiApiKey, model: runtime.config.xaiModel },
  );
  const attachment = await attachSummary(runtime, context.result, summary);
  move(state, {
    summary,
    reasons,
    error: context.error,
    agent: context.agent ? { ...context.agent, ...attachment } : undefined,
  });
}

async function attachSummary(
  runtime: Runtime,
  result: AgentResult | undefined,
  summary: IncidentSummary,
): Promise<{ summaryAttached?: boolean; summaryError?: string }> {
  if (!result?.prUrl || result.source !== "sdk" || !runtime.github.configured) return {};
  try {
    await runtime.github.updatePullBody(result.prUrl, summaryToMarkdown(summary));
    return { summaryAttached: true };
  } catch (error) {
    return {
      summaryAttached: false,
      summaryError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadEvidence(
  runtime: Runtime,
  inbound: InboundIncident,
): Promise<{ evidence: CiEvidence; evidenceNote?: string }> {
  if (inbound.evidence) return { evidence: inbound.evidence };
  if (inbound.kind === "workflow_run" && inbound.runId !== undefined && runtime.github.configured) {
    try {
      return { evidence: await runtime.github.fetchEvidence(inbound.repoUrl, inbound.runId) };
    } catch (error) {
      return {
        evidence: emptyEvidence(),
        evidenceNote: `GitHub evidence fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (inbound.kind === "workflow_run") {
    return {
      evidence: emptyEvidence(),
      evidenceNote: "No job logs were attached and GITHUB_TOKEN is unset, so classification used the payload only.",
    };
  }
  return { evidence: emptyEvidence() };
}

async function loadGateInput(
  runtime: Runtime,
  inbound: InboundIncident,
  result: AgentResult,
  workOnCurrentBranch: boolean,
): Promise<GateInput> {
  if (result.source === "mock") {
    return { ci: result.mockCi ?? "unknown", files: result.mockDiff ?? [] };
  }
  const branch = result.branch ?? (workOnCurrentBranch ? inbound.branch : undefined);
  if (!branch || !inbound.sha) {
    return {
      ci: "unknown",
      files: [],
      note: "The agent diff could not be isolated (missing branch or starting SHA).",
    };
  }
  if (!runtime.github.configured) {
    return { ci: "unknown", files: [], note: "GITHUB_TOKEN is not set, so the agent diff was not read." };
  }
  try {
    return await runtime.github.loadAgentDiff({
      repoUrl: inbound.repoUrl,
      startingSha: inbound.sha,
      branch,
    });
  } catch (error) {
    return {
      ci: "unknown",
      files: [],
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

function withRepo(runtime: Runtime, inbound: InboundIncident): InboundIncident {
  if (inbound.repoUrl) return inbound;
  return { ...inbound, repoUrl: runtime.config.demoRepoUrl };
}

function append(runtime: Runtime, record: AuditRecord): void {
  runtime.audit.append(record);
  runtime.hub.publish({
    incidentId: record.incidentId,
    ts: record.ts,
    state: record.state,
    type: record.type,
    detail: record.detail,
  });
}

function mustView(runtime: Runtime, incidentId: string): IncidentView {
  const view = findIncident(runtime.audit.readAll(), incidentId);
  if (!view) throw new Error(`Incident ${incidentId} missing from the audit log`);
  return view;
}
