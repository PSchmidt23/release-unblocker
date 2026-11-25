import { describe, expect, it } from "vitest";
import { canAskForSmallerDiff, evaluateGates, failedReasons } from "../src/gates.js";
import type { DiffFile, GateInput } from "../src/types.js";

function file(overrides: Partial<DiffFile> & Pick<DiffFile, "filename">): DiffFile {
  return {
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
    ...overrides,
  };
}

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    ci: "success",
    files: [file({ filename: "src/pricing/currency.ts" })],
    ...overrides,
  };
}

describe("gates", () => {
  it("passes a small green diff", () => {
    const report = evaluateGates(input());
    expect(report.passed).toBe(true);
    expect(failedReasons(report)).toEqual([]);
  });

  it("enforces the line and file limits on the boundary", () => {
    expect(evaluateGates(input({
      files: [file({ filename: "src/a.ts", additions: 80, deletions: 0 })],
    })).passed).toBe(true);
    const lines = evaluateGates(input({
      files: [file({ filename: "src/a.ts", additions: 81, deletions: 0 })],
    }));
    expect(lines.passed).toBe(false);
    expect(lines.checks.find((check) => check.id === "diff_lines")?.passed).toBe(false);

    const four = ["a.ts", "b.ts", "c.ts", "d.ts"].map((name) => file({ filename: `src/${name}`, additions: 1, deletions: 0 }));
    expect(evaluateGates(input({ files: four })).passed).toBe(true);
    const five = evaluateGates(input({
      files: [...four, file({ filename: "src/e.ts", additions: 1, deletions: 0 })],
    }));
    expect(five.checks.find((check) => check.id === "diff_files")?.passed).toBe(false);
  });

  it("rejects protected paths, red CI, and pending CI", () => {
    const protectedReport = evaluateGates(input({
      files: [file({ filename: "src/auth/entra.ts" })],
    }));
    expect(protectedReport.checks.find((check) => check.id === "protected_paths")?.reason).toMatch(/src\/auth\/entra.ts/);

    expect(evaluateGates(input({ ci: "failure" })).passed).toBe(false);
    const pending = evaluateGates(input({ ci: "pending", note: "still running" }));
    expect(pending.checks.find((check) => check.id === "ci_green")?.reason).toMatch(/pending/);
    expect(pending.checks.find((check) => check.id === "ci_green")?.reason).toMatch(/still running/);
  });

  it("rejects deleted tests, removed cases, and added skips", () => {
    const deleted = evaluateGates(input({
      files: [file({ filename: "src/proposals/calculator.test.ts", status: "removed", patch: undefined })],
    }));
    expect(deleted.checks.find((check) => check.id === "tests_intact")?.reason).toMatch(/Deleted test file/);

    const skip = evaluateGates(input({
      files: [file({
        filename: "src/proposals/calculator.test.ts",
        patch: "@@ -1 +1 @@\n+it.skip(\"quote total\", () => {\n",
      })],
    }));
    expect(skip.checks.find((check) => check.id === "tests_intact")?.passed).toBe(false);

    const removedCase = evaluateGates(input({
      files: [file({
        filename: "src/proposals/calculator.test.ts",
        patch: "@@ -10 +9,0 @@\n-it(\"quote total rounds half away from zero\", () => {\n",
      })],
    }));
    expect(removedCase.checks.find((check) => check.id === "tests_intact")?.reason).toMatch(/quote total/);

    const kept = evaluateGates(input({
      files: [file({
        filename: "src/proposals/calculator.test.ts",
        patch: [
          "@@ -1,2 +1,2 @@",
          "-it(\"quote total rounds half away from zero\", () => {",
          "+it(\"quote total rounds half away from zero\", () => {",
          "+  expect(quote(1)).toBe(1);",
        ].join("\n"),
      })],
    }));
    expect(kept.checks.find((check) => check.id === "tests_intact")?.passed).toBe(true);
  });

  it("fails closed when a test patch is missing, and ignores an unchanged skip", () => {
    const missing = evaluateGates(input({
      files: [file({ filename: "src/proposals/calculator.test.ts", patch: undefined })],
    }));
    expect(missing.checks.find((check) => check.id === "tests_intact")?.reason).toMatch(/no patch/);

    const contextSkip = evaluateGates(input({
      files: [file({
        filename: "src/proposals/calculator.ts",
        patch: "@@ -1,2 +1,2 @@\n it.skip(\"old\", () => {});\n-const a = 1;\n+const a = 2;\n",
      })],
    }));
    expect(contextSkip.checks.find((check) => check.id === "tests_intact")?.passed).toBe(true);
  });

  it("asks for a smaller diff only when size is the only failure", () => {
    const tooBig = evaluateGates(input({
      files: [file({ filename: "src/a.ts", additions: 100, deletions: 0 })],
    }));
    expect(canAskForSmallerDiff(tooBig)).toBe(true);

    const bigAndRed = evaluateGates(input({
      ci: "failure",
      files: [file({ filename: "src/a.ts", additions: 100, deletions: 0 })],
    }));
    expect(canAskForSmallerDiff(bigAndRed)).toBe(false);

    const auth = evaluateGates(input({ files: [file({ filename: "infra/main.tf", additions: 100, deletions: 0 })] }));
    expect(canAskForSmallerDiff(auth)).toBe(false);
  });
});
