import type {
  AgentResult,
  AuditRecord,
  Classification,
  GateReport,
  IncidentState,
  IncidentSummary,
  IncidentView,
  UsageSnapshot,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asClassification(value: unknown): Classification | undefined {
  if (!isRecord(value) || typeof value.category !== "string" || typeof value.policy !== "string") {
    return undefined;
  }
  return value as unknown as Classification;
}

function asGateReport(value: unknown): GateReport | undefined {
  if (!isRecord(value) || !Array.isArray(value.checks) || typeof value.passed !== "boolean") {
    return undefined;
  }
  return value as unknown as GateReport;
}

function asSummary(value: unknown): IncidentSummary | undefined {
  if (!isRecord(value) || typeof value.whatBroke !== "string" || typeof value.source !== "string") {
    return undefined;
  }
  return value as unknown as IncidentSummary;
}

function asUsage(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value) || typeof value.totalTokens !== "number") return undefined;
  return value as unknown as UsageSnapshot;
}

export function foldIncidents(records: AuditRecord[]): IncidentView[] {
  const byId = new Map<string, IncidentView>();
  for (const record of records) {
    const view = touch(byId, record);
    view.updatedAt = record.ts;
    view.state = record.state;
    view.timeline.push({ ts: record.ts, state: record.state, type: record.type });
    applyDetail(view, record);
  }
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function findIncident(records: AuditRecord[], id: string): IncidentView | undefined {
  return foldIncidents(records).find((view) => view.id === id);
}

function touch(byId: Map<string, IncidentView>, record: AuditRecord): IncidentView {
  const existing = byId.get(record.incidentId);
  if (existing) return existing;
  const created: IncidentView = {
    id: record.incidentId,
    dedupeKeys: record.dedupeKeys ?? [],
    state: record.state,
    createdAt: record.ts,
    updatedAt: record.ts,
    title: record.incidentId,
    gates: [],
    reasons: [],
    timeline: [],
    stream: [],
  };
  byId.set(record.incidentId, created);
  return created;
}

function applyDetail(view: IncidentView, record: AuditRecord): void {
  if (record.dedupeKeys && view.dedupeKeys.length === 0) view.dedupeKeys = record.dedupeKeys;
  const detail = record.detail;
  if (!isRecord(detail)) return;

  if (record.type === "agent_event") {
    const text = typeof detail.text === "string" ? detail.text : "";
    const kind = typeof detail.kind === "string" ? detail.kind : "system";
    view.stream.push({ ts: record.ts, kind, text });
    if (view.stream.length > 80) view.stream.shift();
    return;
  }

  if (typeof detail.title === "string") view.title = detail.title;
  if (detail.source === "workflow_run" || detail.source === "security_finding") view.source = detail.source;
  if (typeof detail.repoUrl === "string") view.repoUrl = detail.repoUrl;
  if (typeof detail.branch === "string") view.branch = detail.branch;
  if (typeof detail.sha === "string") view.sha = detail.sha;
  if (typeof detail.error === "string") view.error = detail.error;

  const classification = asClassification(detail.classification);
  if (classification) view.classification = classification;
  if (typeof detail.evidenceNote === "string") view.evidenceNote = detail.evidenceNote;

  const gate = asGateReport(detail.gate);
  if (gate) view.gates.push(gate);

  const summary = asSummary(detail.summary);
  if (summary) view.summary = summary;

  if (Array.isArray(detail.reasons)) {
    view.reasons = detail.reasons.filter((reason): reason is string => typeof reason === "string");
  }

  if (isRecord(detail.agent)) applyAgent(view, detail.agent);
}

function applyAgent(view: IncidentView, agent: Record<string, unknown>): void {
  const agentId = typeof agent.agentId === "string" ? agent.agentId : view.agent?.agentId;
  if (!agentId) return;
  const runId = typeof agent.runId === "string" ? agent.runId : undefined;
  const runIds = view.agent?.runIds ?? [];
  if (runId && !runIds.includes(runId)) runIds.push(runId);
  const source = agent.source === "sdk" || agent.source === "mock" ? agent.source : view.agent?.source ?? "mock";
  const mode = agent.mode === "plan" || agent.mode === "agent" ? agent.mode : view.agent?.mode ?? "agent";
  view.agent = {
    source,
    agentId,
    runIds,
    mode,
    branch: typeof agent.branch === "string" ? agent.branch : view.agent?.branch,
    prUrl: typeof agent.prUrl === "string" ? agent.prUrl : view.agent?.prUrl,
    attempts: typeof agent.attempt === "number" ? agent.attempt : runIds.length,
    usage: asUsage(agent.usage) ?? view.agent?.usage,
    text: typeof agent.text === "string" ? agent.text : view.agent?.text,
    summaryAttached: typeof agent.summaryAttached === "boolean" ? agent.summaryAttached : view.agent?.summaryAttached,
    summaryError: typeof agent.summaryError === "string" ? agent.summaryError : view.agent?.summaryError,
  };
}

export function agentDetail(result: AgentResult, attempt: number): Record<string, unknown> {
  return {
    source: result.source,
    agentId: result.agentId,
    runId: result.runId,
    mode: result.mode,
    branch: result.branch,
    prUrl: result.prUrl,
    attempt,
    usage: result.usage,
    text: result.text,
  };
}

export function stateOf(view: IncidentView | undefined, fallback: IncidentState): IncidentState {
  return view?.state ?? fallback;
}
