import type { AgentHooks, AgentRequest } from "./agent-request.js";
import type { AgentResult, DiffFile, StreamEvent } from "./types.js";

const lintFix: DiffFile = {
  filename: "src/pricing/currency.ts",
  status: "modified",
  additions: 2,
  deletions: 2,
  patch: [
    "@@ -1,4 +1,3 @@",
    '-import { randomUUID } from "node:crypto";',
    " /**",
    "@@ -94,7 +93,7 @@ function parseRate",
    "-function parseRate(unitsPerUsd: number): number {",
    "+function parseRate(unitsPerUsd: number): { num: bigint; den: bigint } {",
  ].join("\n"),
};

const testFix: DiffFile = {
  filename: "src/proposals/calculator.ts",
  status: "modified",
  additions: 1,
  deletions: 3,
  patch: [
    "@@ -148,6 +148,4 @@ export function buildProposal",
    "-  const subtotal = convert(subtotalUsd, \"USD\", currency);",
    "-  const discount = roundHalfUp(subtotal * discountRate, digits);",
    "-  const total = roundHalfUp(subtotal - discount, digits);",
    "+  const total = convert(totalUsd, \"USD\", currency);",
  ].join("\n"),
};

function oversizedDiff(): DiffFile {
  const added = Array.from({ length: 90 }, (_, index) => `+const pad${index} = ${index};`);
  return {
    filename: "src/pricing/currency.ts",
    status: "modified",
    additions: 90,
    deletions: 0,
    patch: added.join("\n"),
  };
}

function scriptedResult(req: AgentRequest): Pick<AgentResult, "text" | "branch" | "prUrl" | "mockDiff" | "mockCi"> {
  if (req.mode === "plan") {
    return {
      text: "Diagnosis only. SAST-1042 (auth.oidc.missing-audience-bypass, CWE-287) is in src/auth/entra.ts:138. audienceAccepted returns true when the aud claim is missing, so a signed token for this tenant with no audience is accepted. This run did not edit the tree. A human should reject a missing aud.",
      mockDiff: [],
      mockCi: "unknown",
    };
  }
  const shrink = req.attempt > 1;
  const oversized = req.mockBehavior === "oversized-first" && !shrink;
  if (oversized) {
    return {
      text: "Reproduced the failure and applied a broad cleanup. Checks are green, but the diff is larger than the promotion limit.",
      branch: req.workOnCurrentBranch ? req.branchName : "cursor/fix-oversized",
      prUrl: req.autoCreatePR ? `${trimRepo(req.repoUrl)}/pull/900` : undefined,
      mockDiff: [oversizedDiff()],
      mockCi: "success",
    };
  }
  if (req.category === "test_failure") {
    return {
      text: "Reproduced the Vitest failure 'converts the discounted USD total, then rounds half-up': expected 91833, received 91834. buildProposal converts the USD subtotal and then discounts that already-rounded amount, so half-up runs twice. The fix converts totalUsd once. Lint and typecheck were already green. Checks are green.",
      branch: "cursor/fix-quote-rounding",
      prUrl: `${trimRepo(req.repoUrl)}/pull/481`,
      mockDiff: [testFix],
      mockCi: "success",
    };
  }
  return {
    text: "Reproduced CI on ci-fail-lint-type. ESLint reports 'randomUUID' is defined but never used in src/pricing/currency.ts. tsc reports parseRate returns { num: bigint; den: bigint } where a number is declared. The 36 tests passed. Removed the unused import and corrected the return type. Checks are green.",
    branch: req.branchName,
    mockDiff: [lintFix],
    mockCi: "success",
  };
}

function trimRepo(repoUrl: string): string {
  return repoUrl.replace(/\.git$/, "").replace(/\/$/, "");
}

/**
 * Scripted cloud-agent stand-in. Same request and stream hooks as the SDK path,
 * so the dashboard and the audit log look the same in rehearsal.
 */
export async function runMockAgent(req: AgentRequest, hooks: AgentHooks): Promise<AgentResult> {
  const scripted = scriptedResult(req);
  const events: StreamEvent[] = [
    { kind: "status", text: "CREATING" },
    { kind: "status", text: req.mode === "plan" ? "RUNNING plan" : "RUNNING" },
    { kind: "thinking", text: req.mode === "plan" ? "Reading the finding. No edits." : "Reproducing the failure." },
    { kind: "tool", text: req.mode === "plan" ? "read src/auth/entra.ts completed" : "shell npm test completed" },
    { kind: "assistant", text: scripted.text },
    { kind: "usage", text: "1000 tokens (mock)" },
    { kind: "status", text: "FINISHED" },
  ];
  for (const event of events) {
    if (req.streamDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, req.streamDelayMs));
    }
    hooks.onStream(event);
  }
  return {
    source: "mock",
    agentId: req.resumeAgentId ?? `bc-mock-${req.incidentId}`,
    runId: `run-mock-${req.incidentId}-${req.attempt}`,
    mode: req.mode,
    status: "finished",
    text: scripted.text,
    branch: scripted.branch,
    prUrl: scripted.prUrl,
    repoUrl: req.repoUrl,
    usage: {
      inputTokens: 800,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1000,
      chargedCents: 0,
      rawCostCents: 0,
    },
    mockDiff: scripted.mockDiff,
    mockCi: scripted.mockCi,
  };
}
