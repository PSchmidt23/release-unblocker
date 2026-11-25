import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { EventHub } from "../src/hub.js";
import { createGitHubClient } from "../src/github.js";
import { createRuntime, type Runtime } from "../src/orchestrator.js";
import type { ClassifyInput } from "../src/types.js";

export function tempRuntime(extra: Record<string, string> = {}): Runtime {
  const dir = mkdtempSync(join(tmpdir(), "release-unblocker-"));
  const config = loadConfig({
    AUDIT_PATH: join(dir, "audit.jsonl"),
    MOCK_STREAM_DELAY_MS: "0",
    CURSOR_MODEL: "composer-2.5",
    XAI_MODEL: "grok-4.7",
    DEMO_REPO_URL: "https://github.com/PSchmidt23/demo-commercial-app",
    ...extra,
  });
  return createRuntime(
    config,
    createGitHubClient(config.githubToken, { pollAttempts: 1, pollIntervalMs: 0 }),
    new AuditLog(config.auditPath),
    new EventHub(),
  );
}

export function lintInput(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    source: "workflow_run",
    repoUrl: "https://github.com/PSchmidt23/demo-commercial-app",
    branch: "ci-fail-lint-type",
    sha: "abc",
    workflowName: "CI",
    evidence: {
      failedJobs: [
        {
          name: "lint-and-type",
          conclusion: "failure",
          steps: [{ name: "Typecheck", conclusion: "failure" }],
        },
      ],
      logSnippets: ["src/pricing/currency.ts:18:7 - error TS2322: Type 'string' is not assignable to type 'number'."],
    },
    ...overrides,
  };
}
