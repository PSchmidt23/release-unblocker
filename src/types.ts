/** Shared contracts. The state machine, classifier, gates, and dashboard all speak these. */

export type IncidentState =
  | "RECEIVED"
  | "CLASSIFIED"
  | "AGENT_RUNNING"
  | "GATES"
  | "AUTO_FIXED"
  | "PR_OPEN"
  | "ESCALATED"
  | "FAILED";

export type Category =
  | "lint_type"
  | "test_failure"
  | "dependency_cve"
  | "sast"
  | "merge_conflict"
  | "unknown";

export type Risk = "low" | "medium" | "high";

export type Policy = "auto_fix_branch" | "open_fix_pr" | "escalate_human";

export type AgentMode = "agent" | "plan";

export interface FailedStep {
  name: string;
  conclusion?: string | null;
}

export interface FailedJob {
  name: string;
  conclusion?: string | null;
  steps?: FailedStep[];
}

/** What the app knows about the failure before any agent runs. */
export interface CiEvidence {
  failedJobs: FailedJob[];
  logSnippets: string[];
}

export interface SecurityFinding {
  id: string;
  title: string;
  path?: string;
  line?: number;
  severity?: string;
  cve?: string;
  packageName?: string;
  rule?: string;
  cwe?: string;
  description?: string;
}

export interface ClassifyInput {
  source: "workflow_run" | "security_finding";
  repoUrl: string;
  branch: string;
  sha?: string;
  workflowName?: string;
  evidence: CiEvidence;
  finding?: SecurityFinding;
}

export interface Classification {
  category: Category;
  risk: Risk;
  policy: Policy;
  reasons: string[];
  suspectedPaths: string[];
  protectedPaths: string[];
}

export type DiffStatus = "added" | "modified" | "removed" | "renamed";

export interface DiffFile {
  filename: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  patch?: string;
}

export type CiConclusion = "success" | "failure" | "pending" | "unknown";

export interface GateInput {
  ci: CiConclusion;
  files: DiffFile[];
  /** Extra context folded into the CI check reason, such as a GitHub read error. */
  note?: string;
}

export interface GateCheck {
  id: string;
  passed: boolean;
  reason: string;
}

export interface GateReport {
  passed: boolean;
  checks: GateCheck[];
}

export interface IncidentSummary {
  source: "grok" | "template";
  whatBroke: string;
  likelyCause: string;
  whatTheAgentDid: string;
  gateResults: string;
  recommendedAction: string;
  note?: string;
}

export interface StreamEvent {
  kind: "status" | "assistant" | "thinking" | "tool" | "usage" | "summary" | "system";
  text: string;
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  chargedCents?: number;
  rawCostCents?: number;
}

export interface AgentResult {
  source: "sdk" | "mock";
  agentId: string;
  runId: string;
  mode: AgentMode;
  status: "finished" | "error" | "cancelled";
  text: string;
  error?: string;
  branch?: string;
  prUrl?: string;
  repoUrl: string;
  usage?: UsageSnapshot;
  /** Mock runtime only. Real runs read the diff from GitHub. */
  mockDiff?: DiffFile[];
  mockCi?: CiConclusion;
}

export interface InboundIncident {
  kind: "workflow_run" | "security_finding";
  deliveryId?: string;
  runId?: number;
  repoUrl: string;
  repoFullName?: string;
  branch: string;
  sha?: string;
  title: string;
  workflowName?: string;
  htmlUrl?: string;
  finding?: SecurityFinding;
  /** Present when the caller already has the jobs/logs (demo fixtures, tests). */
  evidence?: CiEvidence;
}

export interface AuditRecord {
  v: 1;
  ts: string;
  incidentId: string;
  state: IncidentState;
  type: "transition" | "agent_event";
  dedupeKeys?: string[];
  detail?: unknown;
}

export interface IncidentView {
  id: string;
  dedupeKeys: string[];
  state: IncidentState;
  createdAt: string;
  updatedAt: string;
  source?: "workflow_run" | "security_finding";
  title: string;
  repoUrl?: string;
  branch?: string;
  sha?: string;
  classification?: Classification;
  evidenceNote?: string;
  gates: GateReport[];
  summary?: IncidentSummary;
  reasons: string[];
  agent?: {
    source: "sdk" | "mock";
    agentId: string;
    runIds: string[];
    mode: AgentMode;
    branch?: string;
    prUrl?: string;
    attempts: number;
    usage?: UsageSnapshot;
    text?: string;
    summaryAttached?: boolean;
    summaryError?: string;
  };
  error?: string;
  timeline: Array<{ ts: string; state: IncidentState; type: string }>;
  stream: Array<{ ts: string; kind: string; text: string }>;
}

export const TERMINAL_STATES: readonly IncidentState[] = [
  "AUTO_FIXED",
  "PR_OPEN",
  "ESCALATED",
  "FAILED",
];

export function isTerminal(state: IncidentState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}
