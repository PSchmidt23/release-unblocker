import type { AgentOptions, SDKAgent } from "@cursor/sdk";
import type { AgentMode, Category, StreamEvent } from "./types.js";

/** Everything the SDK seam needs. Built by the orchestrator, never by the agent. */
export interface AgentRequest {
  incidentId: string;
  dryRun: boolean;
  apiKey?: string;
  modelId: string;
  /** Stable per attempt. create and send append their own suffixes. */
  idempotencyKey: string;
  mode: AgentMode;
  repoUrl: string;
  startingRef: string;
  branchName: string;
  autoCreatePR: boolean;
  workOnCurrentBranch: boolean;
  prompt: string;
  resumeAgentId?: string;
  category: Category;
  attempt: number;
  /** Mock only. The SDK path ignores this. */
  mockBehavior?: "happy" | "oversized-first";
  streamDelayMs: number;
}

export interface AgentHooks {
  onStream(event: StreamEvent): void;
}

export interface AgentClient {
  create(options: AgentOptions): Promise<SDKAgent>;
  resume(agentId: string, options?: Partial<AgentOptions>): Promise<SDKAgent>;
}
