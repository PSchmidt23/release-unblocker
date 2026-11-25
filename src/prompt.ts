import { gatesConfig } from "./gates.config.js";
import type { Classification, ClassifyInput } from "./types.js";
import type { GateReport } from "./types.js";
import { failedReasons } from "./gates.js";

export function buildFixPrompt(input: ClassifyInput, classification: Classification): string {
  const logs = input.evidence.logSnippets.slice(0, 20).join("\n");
  const jobs = input.evidence.failedJobs
    .map((job) => {
      const steps = (job.steps ?? []).map((step) => `${step.name}=${step.conclusion ?? "unknown"}`).join(", ");
      return `- ${job.name} (${job.conclusion ?? "unknown"})${steps ? `: ${steps}` : ""}`;
    })
    .join("\n");
  const paths = classification.suspectedPaths.join(", ") || "(none extracted)";
  return [
    `You are the release-unblocker coding agent for ${appName(input.repoUrl)} (${input.repoUrl}).`,
    `Failure category: ${classification.category}. Risk: ${classification.risk}. Policy: ${classification.policy}.`,
    `Branch: ${input.branch}${input.sha ? ` @ ${input.sha}` : ""}.`,
    `Suspected files: ${paths}.`,
    "",
    "What failed:",
    jobs || "(job names were not available)",
    logs || "(no log snippets were available)",
    "",
    "Do this, in order:",
    "1. Reproduce the failure on this VM with the same lint, typecheck, or test command.",
    "2. If no existing test fails for this bug, add one new regression test. Do not otherwise edit tests.",
    "3. Apply the minimal fix.",
    `4. Stay at or under ${gatesConfig.maxChangedLines} changed lines and ${gatesConfig.maxChangedFiles} files.`,
    `5. Do not edit these protected paths: ${gatesConfig.protectedPrefixes.join(", ")}.`,
    "6. Do not delete test files, do not remove test cases, and do not add .skip, .only, xit, or xdescribe.",
    "7. Re-run the checks and leave them green.",
    "8. If you cannot reproduce the failure, stop without editing and say so.",
    "",
    "Report the root cause in a few sentences when you finish.",
  ].join("\n");
}

export function buildDiagnosisPrompt(input: ClassifyInput, classification: Classification): string {
  const logs = input.evidence.logSnippets.slice(0, 20).join("\n");
  return [
    "You are diagnosing a release incident. Do not edit files, do not push, and do not open a pull request.",
    "This is a plan-mode diagnosis. A human will make any change.",
    `Category: ${classification.category}. Risk: ${classification.risk}.`,
    `Protected paths: ${classification.protectedPaths.join(", ") || "(none)"}.`,
    `Reasons: ${classification.reasons.join(" ")}`,
    `Repo: ${input.repoUrl} branch ${input.branch}.`,
    input.finding
      ? `Finding ${input.finding.id}${input.finding.rule ? ` (${input.finding.rule})` : ""} ${input.finding.cwe ?? ""}. ${input.finding.title}. ${input.finding.path ?? "(no path)"}${input.finding.line ? `:${input.finding.line}` : ""}. ${input.finding.description ?? ""}`
      : "",
    logs,
    "",
    "Explain what broke, the likely cause, and the smallest change a human should review. Do not apply it.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function appName(repoUrl: string): string {
  return repoUrl.includes("demo-commercial-app") ? "Northstar Deal Room" : repoUrl;
}

export function buildShrinkPrompt(report: GateReport): string {
  const reasons = failedReasons(report).join(" ");
  return [
    "The promotion gates rejected the diff:",
    reasons,
    `Make a smaller diff. Stay within ${gatesConfig.maxChangedLines} changed lines and ${gatesConfig.maxChangedFiles} files.`,
    "Do not expand scope. Do not touch protected paths. Do not delete, skip, or focus tests.",
    "Re-run the checks and leave them green.",
  ].join("\n");
}
