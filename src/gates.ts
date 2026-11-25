import { gatesConfig, isProtectedPath, isTestFile } from "./gates.config.js";
import type { DiffFile, GateCheck, GateInput, GateReport } from "./types.js";

export interface Gate {
  id: string;
  check: (input: GateInput) => GateCheck;
}

const TEST_TITLE = /\b(?:it|test|describe)\s*\(\s*(['"`])([^'"`]+)\1/;

export function splitPatch(patch: string | undefined): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  if (!patch) return { added, removed };
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added, removed };
}

export function changedLines(files: DiffFile[]): number {
  return files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
}

function ciGreen(input: GateInput): GateCheck {
  const passed = input.ci === "success";
  const reason = passed
    ? "CI on the agent commit is green."
    : `CI is ${input.ci}, not success.${input.note ? ` ${input.note}` : ""}`;
  return { id: "ci_green", passed, reason };
}

function diffLines(input: GateInput): GateCheck {
  const lines = changedLines(input.files);
  const limit = gatesConfig.maxChangedLines;
  const passed = lines <= limit;
  return {
    id: "diff_lines",
    passed,
    reason: passed
      ? `Diff is ${lines} changed lines (limit ${limit}).`
      : `Diff is ${lines} changed lines, over the limit of ${limit}.`,
  };
}

function diffFiles(input: GateInput): GateCheck {
  const count = input.files.length;
  const limit = gatesConfig.maxChangedFiles;
  const passed = count <= limit;
  return {
    id: "diff_files",
    passed,
    reason: passed
      ? `Diff touches ${count} files (limit ${limit}).`
      : `Diff touches ${count} files, over the limit of ${limit}.`,
  };
}

function protectedPaths(input: GateInput): GateCheck {
  const hits = input.files.map((file) => file.filename).filter((filename) => isProtectedPath(filename));
  const passed = hits.length === 0;
  return {
    id: "protected_paths",
    passed,
    reason: passed
      ? "No edits under protected paths."
      : `Protected path edited: ${hits.join(", ")}.`,
  };
}

function testsIntact(input: GateInput): GateCheck {
  const problems: string[] = [];
  for (const file of input.files) {
    if (isTestFile(file.filename) && file.status === "removed") {
      problems.push(`Deleted test file ${file.filename}.`);
      continue;
    }
    const { added, removed } = splitPatch(file.patch);
    if (isTestFile(file.filename) && file.status !== "removed" && !file.patch) {
      problems.push(
        `${file.filename} changed but no patch was available, so a skipped or deleted test cannot be ruled out.`,
      );
    }
    for (const line of added) {
      if (gatesConfig.forbiddenTestMarkers.some((pattern) => pattern.test(line))) {
        problems.push(`Added a skipped or focused test: ${line.trim().slice(0, 160)}`);
      }
    }
    if (!isTestFile(file.filename)) continue;
    const addedText = added.join("\n");
    for (const line of removed) {
      const title = TEST_TITLE.exec(line)?.[2];
      if (title && !addedText.includes(title)) {
        problems.push(`Removed test "${title}" from ${file.filename}.`);
      }
    }
  }
  const passed = problems.length === 0;
  return {
    id: "tests_intact",
    passed,
    reason: passed ? "No deleted test files, removed cases, or added .skip/.only." : problems.join(" "),
  };
}

/** Live extension: append a Gate. Limits live in gates.config.ts. */
export const gateList: Gate[] = [
  { id: "ci_green", check: ciGreen },
  { id: "diff_lines", check: diffLines },
  { id: "diff_files", check: diffFiles },
  { id: "protected_paths", check: protectedPaths },
  { id: "tests_intact", check: testsIntact },
];

const SHRINKABLE = new Set(["diff_lines", "diff_files"]);

export function evaluateGates(input: GateInput, gates: Gate[] = gateList): GateReport {
  const checks = gates.map((gate) => gate.check(input));
  return { passed: checks.every((check) => check.passed), checks };
}

export function failedReasons(report: GateReport): string[] {
  return report.checks.filter((check) => !check.passed).map((check) => check.reason);
}

/**
 * A follow-up is only offered when every failure is size. Protected-path edits,
 * test tampering, and a red CI suite are not things a "smaller diff" can fix.
 */
export function canAskForSmallerDiff(report: GateReport): boolean {
  const failed = report.checks.filter((check) => !check.passed);
  return failed.length > 0 && failed.every((check) => SHRINKABLE.has(check.id));
}
