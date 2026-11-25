import { isProtectedPath } from "./gates.config.js";
import type {
  Category,
  CiEvidence,
  Classification,
  ClassifyInput,
  FailedJob,
  Policy,
  Risk,
} from "./types.js";

/**
 * Category defaults. A protected path overrides these to high / escalate_human.
 *
 * Live extension: add a category here and a detector in detectCategory().
 * merge_conflict stays human: resolving one is guessing someone else's intent.
 * unknown stays human: a writing agent with no diagnosis edits the wrong thing.
 */
const POLICY_BY_CATEGORY: Record<Category, { risk: Risk; policy: Policy; because: string }> = {
  lint_type: {
    risk: "low",
    policy: "auto_fix_branch",
    because: "Lint and type errors are local and mechanical, so the failing branch can be fixed in place.",
  },
  test_failure: {
    risk: "medium",
    policy: "open_fix_pr",
    because: "A failing test can hide a behavior change, so the fix opens a PR instead of landing on the branch.",
  },
  dependency_cve: {
    risk: "medium",
    policy: "open_fix_pr",
    because: "A dependency advisory needs a reviewable PR, not a silent commit.",
  },
  sast: {
    risk: "high",
    policy: "escalate_human",
    because: "A SAST finding is a first-party code vulnerability. It is not auto-fixed.",
  },
  merge_conflict: {
    risk: "medium",
    policy: "escalate_human",
    because: "Merge conflicts are escalated because the agent would be guessing intent.",
  },
  unknown: {
    risk: "high",
    policy: "escalate_human",
    because: "The failure did not match a known class, so a human has to look before anything is edited.",
  },
};

const LINT_TEXT = /error TS\d+|@typescript-eslint|\beslint\b|\btsc\b|prettier/i;
const TEST_TEXT = /\bFAIL\b|AssertionError|\bVitest\b|\bJest\b|Tests? failed|expected .* to (?:be|equal)/i;
const CONFLICT_TEXT = /merge conflict|CONFLICT \(content\)|Automatic merge failed|CONFLICT \(modify\/delete\)/i;
const CVE_TEXT = /\bCVE-\d{4}-\d+\b|\bGHSA-/i;
const LINT_NAME = /\b(lint|eslint|typecheck|type-check|tsc|prettier)\b/i;
const TEST_NAME = /\b(test|vitest|jest|mocha)\b/i;

const PATH_PATTERN = /(?:^|[\s('"])((?:[\w.@-]+\/)+[\w.@-]+\.[\w]+)/g;

function texts(input: ClassifyInput): string[] {
  const chunks = [...input.evidence.logSnippets];
  if (input.finding?.title) chunks.push(input.finding.title);
  if (input.finding?.description) chunks.push(input.finding.description);
  if (input.finding?.cve) chunks.push(input.finding.cve);
  if (input.workflowName) chunks.push(input.workflowName);
  return chunks;
}

/**
 * Northstar's workflow has one job named "lint, typecheck, test". The job
 * title matches every class, so a conclusion on the steps wins over the name.
 * Successful steps are ignored: scenario A fails lint and typecheck while
 * tests pass, and scenario B is the reverse.
 */
function failedSignalNames(jobs: FailedJob[]): { names: string[]; stepsKnown: boolean } {
  const names: string[] = [];
  let stepsKnown = false;
  for (const job of jobs) {
    if (job.conclusion && job.conclusion !== "failure") continue;
    const steps = job.steps ?? [];
    const concluded = steps.filter((step) => step.conclusion);
    if (concluded.length > 0) {
      stepsKnown = true;
      for (const step of concluded) {
        if (step.conclusion === "failure") names.push(step.name);
      }
      continue;
    }
    names.push(job.name);
  }
  return { names, stepsKnown };
}

function collectPaths(input: ClassifyInput): string[] {
  const found = new Set<string>();
  if (input.finding?.path) found.add(repoRelative(input.finding.path));
  const blob = texts(input).join("\n");
  for (const match of blob.matchAll(PATH_PATTERN)) {
    const path = match[1];
    if (!path || path.includes("node_modules/")) continue;
    found.add(repoRelative(path));
  }
  return [...found];
}

/** GitHub logs print absolute runner paths. Policy cares about the repo-relative suffix. */
function repoRelative(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  if (/^(?:src|auth|migrations|infra)\//.test(normalized)) return normalized;
  const markers = ["src/", "auth/", "migrations/", "infra/"];
  let bestIndex = -1;
  let best = normalized.replace(/^\//, "");
  for (const marker of markers) {
    const index = normalized.lastIndexOf(`/${marker}`);
    if (index >= 0 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
      best = normalized.slice(index + 1);
    }
  }
  return best;
}

function isDependencyAdvisory(input: ClassifyInput, blob: string): boolean {
  const finding = input.finding;
  return Boolean(finding?.cve || finding?.packageName || CVE_TEXT.test(`${finding?.title ?? ""}\n${blob}`));
}

function isSastFinding(input: ClassifyInput): boolean {
  const finding = input.finding;
  if (!finding || isDependencyAdvisory(input, "")) return false;
  return Boolean(finding.rule || finding.cwe || /^SAST-/i.test(finding.id));
}

/**
 * Priority is deliberate. A security payload and a merge conflict outrank CI
 * noise. When step conclusions exist, only the failed steps count — the
 * Northstar job name matches lint and test at the same time. If both lint
 * and test steps failed, lint wins: a type error often knocks the suite over.
 */
export function detectCategory(input: ClassifyInput): { category: Category; reason: string } {
  const finding = input.finding;
  const blob = texts(input).join("\n");
  if (input.source === "security_finding" && isDependencyAdvisory(input, blob)) {
    const id = finding?.cve ?? finding?.packageName ?? "advisory";
    return {
      category: "dependency_cve",
      reason: `Security finding ${id} is classified as a dependency advisory.`,
    };
  }
  if (input.source === "security_finding" && isSastFinding(input)) {
    const where = finding?.path
      ? `${finding.path}${finding.line ? `:${finding.line}` : ""}`
      : "an unknown file";
    return {
      category: "sast",
      reason: `SAST ${finding?.id ?? ""} ${finding?.rule ?? ""} (${finding?.cwe ?? "no CWE"}) at ${where || "an unknown file"}. ${finding?.description ?? ""}`.replace(/\s+/g, " ").trim(),
    };
  }
  if (CONFLICT_TEXT.test(blob)) {
    return { category: "merge_conflict", reason: "Logs contain a merge conflict marker." };
  }

  const { names, stepsKnown } = failedSignalNames(input.evidence.failedJobs);
  const stepLint = names.some((name) => LINT_NAME.test(name));
  const stepTest = names.some((name) => TEST_NAME.test(name));
  const logLint = LINT_TEXT.test(blob);
  const logTest = TEST_TEXT.test(blob);

  if (stepsKnown) {
    if (stepLint && !stepTest) {
      return { category: "lint_type", reason: "A lint or typecheck step failed. Passing test steps were ignored." };
    }
    if (stepTest && !stepLint) {
      return { category: "test_failure", reason: "A test step failed. Passing lint and typecheck steps were ignored." };
    }
    if (stepLint && stepTest) {
      return {
        category: "lint_type",
        reason: "Lint and test steps both failed. Lint is classified first because a type error often fails the suite.",
      };
    }
  } else {
    if (logLint && !logTest) {
      return { category: "lint_type", reason: "Logs contain a TypeScript or ESLint diagnostic." };
    }
    if (logTest && !logLint) {
      return { category: "test_failure", reason: "Logs contain a test assertion failure." };
    }
    if (stepLint && stepTest) {
      return {
        category: "unknown",
        reason: "The job name matches lint and test, and no failed step was isolated.",
      };
    }
    if (stepLint || logLint) {
      return { category: "lint_type", reason: "A failed lint/type job or a TypeScript/ESLint diagnostic is present." };
    }
    if (stepTest || logTest) {
      return { category: "test_failure", reason: "A failed test job or an assertion failure is present." };
    }
  }

  if (input.source === "security_finding") {
    return {
      category: "unknown",
      reason: "Security finding had no CVE, GHSA, package, SAST rule, or CWE.",
    };
  }
  return {
    category: "unknown",
    reason: "No failed step, log snippet, or finding matched lint, test, CVE, SAST, or merge conflict.",
  };
}

export function classify(input: ClassifyInput): Classification {
  const suspectedPaths = collectPaths(input);
  const protectedPaths = suspectedPaths.filter((path) => isProtectedPath(path));
  const detected = detectCategory(input);
  const base = POLICY_BY_CATEGORY[detected.category];
  const reasons = [detected.reason, base.because];

  if (protectedPaths.length > 0) {
    reasons.push(`Protected path ${protectedPaths.join(", ")} forces high risk and a human decision.`);
    return {
      category: detected.category,
      risk: "high",
      policy: "escalate_human",
      reasons,
      suspectedPaths,
      protectedPaths,
    };
  }

  return {
    category: detected.category,
    risk: base.risk,
    policy: base.policy,
    reasons,
    suspectedPaths,
    protectedPaths,
  };
}

export function emptyEvidence(): CiEvidence {
  return { failedJobs: [], logSnippets: [] };
}
