import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentUsage, RunResult, SDKAgent, SDKMessage } from "@cursor/sdk";
import { IncidentMachine } from "../src/state.js";
import { acceptIncident, runIncident } from "../src/orchestrator.js";
import { parseInbound } from "../src/webhook.js";
import { runReleaseAgent, toStreamEvent, type AgentRequest } from "../src/agent.js";
import { runMockAgent } from "../src/mock-agent.js";
import { parseSummaryText, templateSummary } from "../src/summarize.js";
import { tempRuntime } from "./helpers.js";
import type { AgentClient } from "../src/agent-request.js";
import type { InboundIncident } from "../src/types.js";

function loadInbound(name: string): InboundIncident {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const parsed = parseInbound(JSON.parse(readFileSync(path, "utf8")) as unknown, undefined);
  if (parsed.type !== "incident") throw new Error("fixture did not parse");
  return parsed.inbound;
}

describe("state machine", () => {
  it("allows the promotion path and rejects skips", () => {
    const machine = new IncidentMachine("RECEIVED");
    expect(() => machine.transition("AUTO_FIXED")).toThrow(/Illegal transition RECEIVED -> AUTO_FIXED/);
    machine.transition("CLASSIFIED");
    machine.transition("FAILED");
    expect(() => machine.transition("CLASSIFIED")).toThrow(/Illegal transition FAILED/);

    const happy = new IncidentMachine("RECEIVED");
    for (const state of ["CLASSIFIED", "AGENT_RUNNING", "GATES", "AUTO_FIXED"] as const) {
      happy.transition(state);
    }
    expect(happy.state).toBe("AUTO_FIXED");
  });

  it("runs scenario A to AUTO_FIXED, B to PR_OPEN, and C to a diagnosis", async () => {
    const runtime = tempRuntime();
    const a = loadInbound("scenario-a.json");
    const acceptedA = acceptIncident(runtime, a);
    const viewA = await runIncident(runtime, acceptedA.incidentId, a, { dryRun: true });
    expect(viewA.state).toBe("AUTO_FIXED");
    expect(viewA.classification?.policy).toBe("auto_fix_branch");
    expect(viewA.agent?.mode).toBe("agent");
    expect(viewA.agent?.source).toBe("mock");
    expect(viewA.agent?.branch).toBe("ci-fail-lint-type");
    expect(viewA.gates).toHaveLength(1);
    expect(viewA.gates[0]?.passed).toBe(true);
    expect(viewA.summary?.source).toBe("template");
    expect(viewA.agent?.text).toMatch(/randomUUID/);
    expect(viewA.agent?.text).toMatch(/parseRate/);
    expect(viewA.title).toMatch(/Tighten parseRate/);
    expect(viewA.timeline.filter((step) => step.type === "transition").map((step) => step.state)).toEqual([
      "RECEIVED",
      "CLASSIFIED",
      "AGENT_RUNNING",
      "GATES",
      "AUTO_FIXED",
    ]);
    expect(viewA.stream.length).toBeGreaterThan(0);

    const b = loadInbound("scenario-b.json");
    const viewB = await runIncident(runtime, acceptIncident(runtime, b).incidentId, b, { dryRun: true });
    expect(viewB.state).toBe("PR_OPEN");
    expect(viewB.agent?.prUrl).toMatch(/\/pull\/481$/);
    expect(viewB.classification?.category).toBe("test_failure");
    expect(viewB.agent?.text).toMatch(/91833/);
    expect(viewB.title).toMatch(/Discount the rounded quote-currency subtotal/);

    const c = loadInbound("scenario-c.json");
    const seen: AgentRequest[] = [];
    const viewC = await runIncident(runtime, acceptIncident(runtime, c).incidentId, c, {
      dryRun: true,
      agent: async (request, hooks) => {
        seen.push(request);
        return runMockAgent(request, hooks);
      },
    });
    expect(viewC.state).toBe("ESCALATED");
    expect(viewC.classification?.category).toBe("sast");
    expect(viewC.agent?.text).toMatch(/audienceAccepted/);
    expect(viewC.classification?.reasons.join(" ")).toMatch(/src\/auth\/entra.ts/);
    expect(viewC.classification?.risk).toBe("high");
    expect(viewC.gates).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.mode).toBe("plan");
    expect(seen[0]?.autoCreatePR).toBe(false);
    expect(seen[0]?.workOnCurrentBranch).toBe(false);
    expect(viewC.agent?.mode).toBe("plan");
  });

  it("resumes the same agent once when the diff is only too big", async () => {
    const runtime = tempRuntime();
    const inbound = loadInbound("scenario-a.json");
    const seen: AgentRequest[] = [];
    const view = await runIncident(runtime, acceptIncident(runtime, inbound).incidentId, inbound, {
      dryRun: true,
      mockBehavior: "oversized-first",
      agent: async (request, hooks) => {
        seen.push(request);
        return runMockAgent(request, hooks);
      },
    });
    expect(seen.map((request) => request.attempt)).toEqual([1, 2]);
    expect(seen[1]?.resumeAgentId).toBe(`bc-mock-${view.id}`);
    expect(seen[1]?.prompt).toMatch(/smaller diff/i);
    expect(view.state).toBe("AUTO_FIXED");
    expect(view.gates.map((report) => report.passed)).toEqual([false, true]);
    expect(view.agent?.attempts).toBe(2);
  });

  it("escalates a workflow run that has no logs instead of guessing from the branch", async () => {
    const runtime = tempRuntime();
    const inbound = loadInbound("scenario-a.json");
    inbound.evidence = undefined;
    const view = await runIncident(runtime, acceptIncident(runtime, inbound).incidentId, inbound, { dryRun: true });
    expect(view.classification?.category).toBe("unknown");
    expect(view.state).toBe("ESCALATED");
    expect(view.agent?.mode).toBe("plan");
    expect(view.evidenceNote).toMatch(/GITHUB_TOKEN/);
  });

  it("drives the real SDK call shape through a fake client", async () => {
    const created: string[] = [];
    const sent: Array<{ idempotencyKey?: string; mode?: string }> = [];
    let disposed = false;
    const usage: AgentUsage = {
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 14,
      },
      cost: { rawCostCents: 3, chargedCents: 2 },
      runs: [],
    };
    const result: RunResult = {
      id: "run-1",
      status: "finished",
      result: "fixed the type error",
      git: {
        branches: [{ repoUrl: "https://github.com/PSchmidt23/demo-commercial-app", branch: "ci-fail-lint-type" }],
      },
      usage: usage.usage,
    };
    const client: AgentClient = {
      async create(options) {
        created.push(`${options.mode}:${options.cloud?.autoCreatePR}:${options.cloud?.workOnCurrentBranch}:${options.idempotencyKey}`);
        return fakeAgent("bc-live", result, usage, sent, () => {
          disposed = true;
        });
      },
      async resume(agentId) {
        created.push(`resume:${agentId}`);
        return fakeAgent(agentId, result, usage, sent, () => {
          disposed = true;
        });
      },
    };

    const request: AgentRequest = {
      incidentId: "inc_test",
      dryRun: false,
      apiKey: "cursor_test",
      modelId: "composer-2.5",
      idempotencyKey: "ru:inc_test:1",
      mode: "agent",
      repoUrl: "https://github.com/PSchmidt23/demo-commercial-app",
      startingRef: "a11ce0000000000000000000000000000000a11c",
      branchName: "ci-fail-lint-type",
      autoCreatePR: false,
      workOnCurrentBranch: true,
      prompt: "fix the type error",
      category: "lint_type",
      attempt: 1,
      streamDelayMs: 0,
    };
    const events: string[] = [];
    const first = await runReleaseAgent(request, { onStream: (event) => events.push(event.text) }, client);
    expect(created).toEqual(["agent:false:true:ru:inc_test:1:create"]);
    expect(sent[0]).toMatchObject({ idempotencyKey: "ru:inc_test:1:send", mode: "agent" });
    expect(events.some((text) => text.includes("RUNNING"))).toBe(true);
    expect(first.agentId).toBe("bc-live");
    expect(first.branch).toBe("ci-fail-lint-type");
    expect(first.usage?.chargedCents).toBe(2);
    expect(disposed).toBe(true);

    disposed = false;
    await runReleaseAgent({ ...request, resumeAgentId: "bc-live", attempt: 2, idempotencyKey: "ru:inc_test:2" }, { onStream: () => {} }, client);
    expect(created[1]).toBe("resume:bc-live");
    expect(disposed).toBe(true);

    const streamed = toStreamEvent({
      type: "tool_call",
      agent_id: "bc-live",
      run_id: "run-1",
      call_id: "c1",
      name: "shell",
      status: "completed",
    });
    expect(streamed).toEqual({ kind: "tool", text: "shell completed" });
  });

  it("keeps a template when Grok is not configured and parses a schema payload", () => {
    const summary = templateSummary({
      state: "ESCALATED",
      title: "CI failed on ci-fail-lint-type",
      reasons: ["No failed job matched."],
    });
    expect(summary.source).toBe("template");
    expect(summary.recommendedAction).toMatch(/human/i);

    const parsed = parseSummaryText(JSON.stringify({
      whatBroke: "Typecheck failed.",
      likelyCause: "A string was assigned to a number.",
      whatTheAgentDid: "Nothing. Diagnosis only.",
      gateResults: "Gates skipped.",
      recommendedAction: "Read src/auth/entra.ts.",
    }));
    expect(parsed?.source).toBe("grok");
    expect(parseSummaryText("not json")).toBeUndefined();
  });
});

function fakeAgent(
  agentId: string,
  result: RunResult,
  usage: AgentUsage,
  sent: Array<{ idempotencyKey?: string; mode?: string }>,
  onDispose: () => void,
): SDKAgent {
  const run = {
    id: result.id,
    agentId,
    status: "finished" as const,
    supports: () => true,
    async *stream(): AsyncGenerator<SDKMessage> {
      yield { type: "status", agent_id: agentId, run_id: result.id, status: "RUNNING" };
    },
    wait: async () => result,
  };
  return {
    agentId,
    model: { id: "composer-2.5" },
    async send(_prompt: string, options?: { idempotencyKey?: string; mode?: string }) {
      sent.push({ idempotencyKey: options?.idempotencyKey, mode: options?.mode });
      return run;
    },
    async getUsage() {
      return usage;
    },
    async [Symbol.asyncDispose]() {
      onDispose();
    },
    close() {},
    async reload() {},
    async listArtifacts() {
      return [];
    },
    async downloadArtifact() {
      return Buffer.alloc(0);
    },
    async summarize() {
      return run;
    },
  } as unknown as SDKAgent;
}
