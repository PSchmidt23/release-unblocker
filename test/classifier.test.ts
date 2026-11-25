import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classify } from "../src/classifier.js";
import { snippetsFromLog } from "../src/github.js";
import { parseInbound } from "../src/webhook.js";
import { lintInput } from "./helpers.js";
import type { ClassifyInput } from "../src/types.js";

describe("classifier", () => {
  it("maps a type error to a low-risk in-place fix", () => {
    const result = classify(lintInput());
    expect(result.category).toBe("lint_type");
    expect(result.risk).toBe("low");
    expect(result.policy).toBe("auto_fix_branch");
    expect(result.suspectedPaths).toContain("src/pricing/currency.ts");
    expect(result.protectedPaths).toEqual([]);
  });

  it("maps a Vitest failure to a reviewable PR", () => {
    const result = classify(lintInput({
      branch: "ci-fail-test",
      evidence: {
        failedJobs: [{ name: "test", conclusion: "failure", steps: [{ name: "Vitest", conclusion: "failure" }] }],
        logSnippets: [
          "FAIL src/proposals/calculator.test.ts > quote total rounds half away from zero",
          "AssertionError: expected 10.02 to be 10.03",
        ],
      },
    }));
    expect(result.category).toBe("test_failure");
    expect(result.risk).toBe("medium");
    expect(result.policy).toBe("open_fix_pr");
    expect(result.suspectedPaths).toContain("src/proposals/calculator.test.ts");
  });

  it("escalates the Northstar SAST finding on src/auth/entra.ts", () => {
    const input: ClassifyInput = {
      source: "security_finding",
      repoUrl: "https://github.com/PSchmidt23/demo-commercial-app",
      branch: "main",
      evidence: { failedJobs: [], logSnippets: [] },
      finding: {
        id: "SAST-1042",
        title: "SAST-1042 auth.oidc.missing-audience-bypass",
        rule: "auth.oidc.missing-audience-bypass",
        cwe: "CWE-287",
        path: "src/auth/entra.ts",
        line: 138,
        severity: "high",
        description: "audienceAccepted returns true when aud is missing.",
      },
    };
    const result = classify(input);
    expect(result.category).toBe("sast");
    expect(result.risk).toBe("high");
    expect(result.policy).toBe("escalate_human");
    expect(result.protectedPaths).toEqual(["src/auth/entra.ts"]);
    expect(result.reasons.join(" ")).toMatch(/SAST-1042/);
    expect(result.reasons.join(" ")).toMatch(/CWE-287/);
  });

  it("does not let the combined CI job name override a failed test step", () => {
    const result = classify(lintInput({
      branch: "ci-fail-test",
      evidence: {
        failedJobs: [{
          name: "lint, typecheck, test",
          conclusion: "failure",
          steps: [
            { name: "Run npm run lint", conclusion: "success" },
            { name: "Run npm run typecheck", conclusion: "success" },
            { name: "Run npm test", conclusion: "failure" },
          ],
        }],
        logSnippets: [
          "FAIL  src/proposals/calculator.test.ts > buildProposal > converts the discounted USD total, then rounds half-up",
          "AssertionError: expected 91834 to be 91833 // Object.is equality",
        ],
      },
    }));
    expect(result.category).toBe("test_failure");
    expect(result.policy).toBe("open_fix_pr");
  });

  it("ignores a passing test step when lint and typecheck failed", () => {
    const result = classify(lintInput({
      evidence: {
        failedJobs: [{
          name: "lint, typecheck, test",
          conclusion: "failure",
          steps: [
            { name: "Run npm run lint", conclusion: "failure" },
            { name: "Run npm run typecheck", conclusion: "failure" },
            { name: "Run npm test", conclusion: "success" },
          ],
        }],
        logSnippets: [
          "1:10  error  'randomUUID' is defined but never used  @typescript-eslint/no-unused-vars",
          "src/pricing/currency.ts(97,3): error TS2322: Type '{ num: bigint; den: bigint; }' is not assignable to type 'number'.",
        ],
      },
    }));
    expect(result.category).toBe("lint_type");
    expect(result.policy).toBe("auto_fix_branch");
    expect(result.suspectedPaths).toContain("src/pricing/currency.ts");
  });

  it("opens a PR for a CVE that does not touch a protected path", () => {
    const result = classify({
      source: "security_finding",
      repoUrl: "https://github.com/acme/app",
      branch: "main",
      evidence: { failedJobs: [], logSnippets: [] },
      finding: {
        id: "lodash",
        title: "GHSA-1234 prototype pollution",
        packageName: "lodash",
        path: "src/pricing/currency.ts",
      },
    });
    expect(result.category).toBe("dependency_cve");
    expect(result.risk).toBe("medium");
    expect(result.policy).toBe("open_fix_pr");
  });

  it("does not treat a branch name as evidence", () => {
    const result = classify(lintInput({
      branch: "ci-fail-lint-type",
      evidence: { failedJobs: [], logSnippets: [] },
    }));
    expect(result.category).toBe("unknown");
    expect(result.risk).toBe("high");
    expect(result.policy).toBe("escalate_human");
  });

  it("escalates merge conflicts and protected lint failures", () => {
    const conflict = classify(lintInput({
      evidence: {
        failedJobs: [{ name: "test", conclusion: "failure" }],
        logSnippets: ["CONFLICT (content): Merge conflict in src/proposals/calculator.ts"],
      },
    }));
    expect(conflict.category).toBe("merge_conflict");
    expect(conflict.policy).toBe("escalate_human");

    const authLint = classify(lintInput({
      evidence: {
        failedJobs: [{ name: "typecheck", conclusion: "failure" }],
        logSnippets: ["src/auth/session.ts:4:1 - error TS2304: Cannot find name 'Token'."],
      },
    }));
    expect(authLint.category).toBe("lint_type");
    expect(authLint.risk).toBe("high");
    expect(authLint.policy).toBe("escalate_human");
  });

  it("prefers the type error when lint and tests both failed", () => {
    const result = classify(lintInput({
      evidence: {
        failedJobs: [
          { name: "lint-and-type", conclusion: "failure", steps: [{ name: "tsc", conclusion: "failure" }] },
          { name: "test", conclusion: "failure", steps: [{ name: "Vitest", conclusion: "failure" }] },
        ],
        logSnippets: ["error TS2322: Type 'string' is not assignable to type 'number'."],
      },
    }));
    expect(result.category).toBe("lint_type");
  });

  it("classifies the checked-in Northstar fixtures and keeps the eslint path", () => {
    const finding = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/findings/cve-auth-bypass.json", import.meta.url)), "utf8")) as unknown;
    const parsed = parseInbound(finding, undefined);
    expect(parsed.type).toBe("incident");
    if (parsed.type !== "incident") return;
    const result = classify({
      source: parsed.inbound.kind,
      repoUrl: "https://github.com/PSchmidt23/demo-commercial-app",
      branch: parsed.inbound.branch,
      evidence: { failedJobs: [], logSnippets: [] },
      finding: parsed.inbound.finding,
    });
    expect(result.category).toBe("sast");
    expect(result.protectedPaths).toEqual(["src/auth/entra.ts"]);

    const snippets = snippetsFromLog([
      "2026-11-25T21:16:36.7436613Z /home/runner/work/demo-commercial-app/demo-commercial-app/src/pricing/currency.ts",
      "2026-11-25T21:16:36.7458736Z ##[error]  1:10  error  'randomUUID' is defined but never used  @typescript-eslint/no-unused-vars",
    ].join("\n"));
    expect(snippets.some((line) => line.includes("src/pricing/currency.ts"))).toBe(true);
    expect(snippets.some((line) => line.includes("randomUUID"))).toBe(true);
  });

  it("treats migrations and infra as protected", () => {
    const result = classify(lintInput({
      evidence: {
        failedJobs: [{ name: "typecheck", conclusion: "failure" }],
        logSnippets: ["migrations/004_users.ts:1:1 - error TS2304: Cannot find name 'sql'."],
      },
    }));
    expect(result.protectedPaths).toContain("migrations/004_users.ts");
    expect(result.policy).toBe("escalate_human");
  });
});
