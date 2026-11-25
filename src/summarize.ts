/**
 * Optional Grok summary. Kept apart from the Cursor agent on purpose:
 * one SDK edits the repo, the other only writes a paragraph.
 *
 * API verified against docs.x.ai (Nov 2026): POST https://api.x.ai/v1/responses
 * with text.format json_schema. Default model grok-4.7, override with XAI_MODEL.
 * When XAI_API_KEY is unset, a template is returned and the incident continues.
 */
import type { IncidentState, IncidentSummary } from "./types.js";

export interface SummaryInput {
  state: IncidentState;
  category?: string;
  risk?: string;
  policy?: string;
  branch?: string;
  title: string;
  reasons: string[];
  agentText?: string;
  gateResults?: string;
  protectedPaths?: string[];
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["whatBroke", "likelyCause", "whatTheAgentDid", "gateResults", "recommendedAction"],
  properties: {
    whatBroke: { type: "string" },
    likelyCause: { type: "string" },
    whatTheAgentDid: { type: "string" },
    gateResults: { type: "string" },
    recommendedAction: { type: "string" },
  },
} as const;

const SYSTEM = [
  "You write a short incident note for a release engineer.",
  "Use only the facts in the user message. Do not invent commits, pull requests, files, or gate results.",
  "Plain sentences. No markdown.",
].join(" ");

export function templateSummary(input: SummaryInput, note?: string): IncidentSummary {
  const category = input.category ?? "unclassified";
  return {
    source: "template",
    whatBroke: `${input.title} (${category}${input.branch ? ` on ${input.branch}` : ""}).`,
    likelyCause: input.reasons[0] ?? "The classifier did not record a cause.",
    whatTheAgentDid: input.agentText?.slice(0, 500) || "No agent narrative was recorded.",
    gateResults: input.gateResults ?? "Gates did not run.",
    recommendedAction: recommendedAction(input.state),
    note,
  };
}

export function summaryToMarkdown(summary: IncidentSummary): string {
  return [
    "## Release Unblocker",
    "",
    `**What broke.** ${summary.whatBroke}`,
    "",
    `**Likely cause.** ${summary.likelyCause}`,
    "",
    `**What the agent did.** ${summary.whatTheAgentDid}`,
    "",
    `**Gates.** ${summary.gateResults}`,
    "",
    `**Recommended action.** ${summary.recommendedAction}`,
    "",
    `_Summary source: ${summary.source}${summary.note ? `. ${summary.note}` : ""}._`,
  ].join("\n");
}

export function parseSummaryText(text: string): IncidentSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const fields = ["whatBroke", "likelyCause", "whatTheAgentDid", "gateResults", "recommendedAction"] as const;
  if (!fields.every((field) => typeof record[field] === "string" && (record[field] as string).trim())) {
    return undefined;
  }
  return {
    source: "grok",
    whatBroke: record.whatBroke as string,
    likelyCause: record.likelyCause as string,
    whatTheAgentDid: record.whatTheAgentDid as string,
    gateResults: record.gateResults as string,
    recommendedAction: record.recommendedAction as string,
  };
}

export function extractOutputText(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  if (!Array.isArray(record.output)) return undefined;
  for (const item of record.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typed = part as { type?: unknown; text?: unknown };
      if (typed.type === "output_text" && typeof typed.text === "string") return typed.text;
    }
  }
  return undefined;
}

export async function summarizeIncident(
  input: SummaryInput,
  options: { apiKey?: string; model: string; fetchImpl?: typeof fetch },
): Promise<IncidentSummary> {
  if (!options.apiKey) return templateSummary(input);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        input: [
          { role: "system", content: SYSTEM },
          { role: "user", content: JSON.stringify(facts(input)) },
        ],
        max_output_tokens: 700,
        text: {
          format: {
            type: "json_schema",
            name: "incident_summary",
            strict: true,
            schema: SCHEMA,
          },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return templateSummary(input, `Grok returned HTTP ${response.status}; template used.`);
    }
    const summary = parseSummaryText(extractOutputText(await response.json()) ?? "");
    if (!summary) return templateSummary(input, "Grok response did not match the summary schema; template used.");
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return templateSummary(input, `Grok call failed (${message}); template used.`);
  }
}

function facts(input: SummaryInput): Record<string, unknown> {
  return {
    title: input.title,
    state: input.state,
    category: input.category ?? null,
    risk: input.risk ?? null,
    policy: input.policy ?? null,
    branch: input.branch ?? null,
    protectedPaths: input.protectedPaths ?? [],
    classifierReasons: input.reasons,
    agentNarrative: input.agentText ?? null,
    gateResults: input.gateResults ?? null,
  };
}

function recommendedAction(state: IncidentState): string {
  switch (state) {
    case "AUTO_FIXED":
      return "Review the commit on the failing branch, then merge when you are satisfied.";
    case "PR_OPEN":
      return "Review the fix pull request. The gates passed; a human still merges.";
    case "ESCALATED":
      return "A human should take this incident. Do not promote the branch automatically.";
    case "FAILED":
      return "The automation failed before a promotion decision. Read the error and rerun once the cause is fixed.";
    default:
      return "Wait for the incident to reach a terminal state.";
  }
}
