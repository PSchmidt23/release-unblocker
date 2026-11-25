/**
 * The only module that talks to @cursor/sdk.
 *
 * Verified against @cursor/sdk 1.5.0:
 *   Agent.create, Agent.resume, agent.send, run.stream, run.wait, agent.getUsage.
 *
 * Differences from a short sketch of the API:
 *   - model is `{ id }`, not a bare string. Default id is composer-2.5
 *     (composer-2 is retired and rerouted).
 *   - idempotencyKey is valid on Agent.create AND on send(). Creation and the
 *     prompt are different operations, so they get different keys.
 *   - getUsage() returns `{ usage, cost?, runs }`. Cost is integer cents and
 *     may be absent until billing settles.
 *   - run.stream() yields SDKMessage, including a "summary" event the sketch
 *     omitted. Tool args are not stable; this file records only name + status.
 *   - tools / disallowedTools / systemPrompt are local-agent only. Combining
 *     them with `cloud` throws ConfigurationError. A diagnosis therefore uses
 *     mode: "plan", autoCreatePR: false, and a prompt that forbids edits.
 *     Plan mode is the supported non-writing conversation mode.
 */
import type {
  AgentOptions,
  AgentUsage,
  RunResult,
  SDKMessage,
  SendOptions,
} from "@cursor/sdk";
import type { AgentClient, AgentHooks, AgentRequest } from "./agent-request.js";
import { runMockAgent } from "./mock-agent.js";
import type { AgentResult, StreamEvent } from "./types.js";

export type { AgentClient, AgentHooks, AgentRequest } from "./agent-request.js";

export function buildAgentCreateOptions(req: AgentRequest): AgentOptions {
  if (!req.apiKey) throw new Error("CURSOR_API_KEY is not set");
  return {
    apiKey: req.apiKey,
    name: `release-unblocker ${req.incidentId}`,
    model: { id: req.modelId },
    idempotencyKey: `${req.idempotencyKey}:create`,
    mode: req.mode,
    cloud: {
      repos: [{ url: req.repoUrl, startingRef: req.startingRef }],
      autoCreatePR: req.autoCreatePR,
      workOnCurrentBranch: req.workOnCurrentBranch,
      metadata: {
        incidentId: req.incidentId,
        category: req.category,
        attempt: String(req.attempt),
      },
    },
  };
}

export function buildResumeOptions(req: AgentRequest): Partial<AgentOptions> {
  return {
    apiKey: req.apiKey,
    model: { id: req.modelId },
    mode: req.mode,
  };
}

export function toStreamEvent(message: SDKMessage): StreamEvent {
  switch (message.type) {
    case "assistant": {
      const text = message.message.content
        .map((block) => (block.type === "text" ? block.text : `tool ${block.name}`))
        .join("");
      return { kind: "assistant", text: clip(text) };
    }
    case "thinking":
      return { kind: "thinking", text: clip(message.text) };
    case "tool_call":
      return { kind: "tool", text: `${message.name} ${message.status}` };
    case "status":
      return {
        kind: "status",
        text: message.message ? `${message.status} ${message.message}` : message.status,
      };
    case "usage":
      return { kind: "usage", text: `${message.usage.totalTokens} tokens` };
    case "summary":
      return { kind: "summary", text: message.status };
    case "system":
      return { kind: "system", text: message.model?.id ?? "init" };
    case "user":
      return { kind: "system", text: "prompt accepted" };
    case "task":
      return { kind: "status", text: clip(message.text ?? message.status ?? "task") };
    case "request":
      return { kind: "status", text: `awaiting input ${message.request_id}` };
    default: {
      const unreachable: never = message;
      return { kind: "system", text: String(unreachable) };
    }
  }
}

export async function runReleaseAgent(
  req: AgentRequest,
  hooks: AgentHooks,
  client?: AgentClient,
): Promise<AgentResult> {
  if (req.dryRun) return runMockAgent(req, hooks);
  return runSdkAgent(req, hooks, client ?? (await defaultClient()));
}

async function defaultClient(): Promise<AgentClient> {
  const sdk = await import("@cursor/sdk");
  return {
    create: (options) => sdk.Agent.create(options),
    resume: (agentId, options) => sdk.Agent.resume(agentId, options),
  };
}

async function runSdkAgent(req: AgentRequest, hooks: AgentHooks, client: AgentClient): Promise<AgentResult> {
  const agent = req.resumeAgentId
    ? await client.resume(req.resumeAgentId, buildResumeOptions(req))
    : await client.create(buildAgentCreateOptions(req));
  try {
    const sendOptions: SendOptions = {
      idempotencyKey: `${req.idempotencyKey}:send`,
      mode: req.mode,
    };
    const run = await agent.send(req.prompt, sendOptions);
    if (run.supports("stream")) {
      for await (const event of run.stream()) {
        hooks.onStream(toStreamEvent(event));
      }
    }
    const result = await run.wait();
    let billed: AgentUsage | undefined;
    try {
      billed = await agent.getUsage();
    } catch (error) {
      hooks.onStream({ kind: "usage", text: `getUsage unavailable: ${messageOf(error)}` });
    }
    return mapResult(req, agent.agentId, result, billed);
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

function mapResult(req: AgentRequest, agentId: string, result: RunResult, billed: AgentUsage | undefined): AgentResult {
  const branch = result.git?.branches[0];
  const usage = billed?.usage ?? result.usage;
  return {
    source: "sdk",
    agentId,
    runId: result.id,
    mode: req.mode,
    status: result.status,
    text: result.result ?? "",
    error: result.error?.message,
    branch: branch?.branch,
    prUrl: branch?.prUrl,
    repoUrl: branch?.repoUrl ?? req.repoUrl,
    usage: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          totalTokens: usage.totalTokens,
          reasoningTokens: usage.reasoningTokens,
          chargedCents: billed?.cost?.chargedCents,
          rawCostCents: billed?.cost?.rawCostCents,
        }
      : undefined,
  };
}

function clip(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
