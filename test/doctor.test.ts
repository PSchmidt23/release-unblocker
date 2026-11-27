import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { formatDoctorText, main, nodeVersionOk, runDoctor, type DoctorCheck } from "../src/doctor.js";

const CURSOR_KEY = "crsr_live_example_9f3a";
const GITHUB_TOKEN = "ghp_test_token_zz9Q";
const XAI_KEY = "xai_test_secret_88aa";

function status(checks: DoctorCheck[], id: string): DoctorCheck {
  const found = checks.find((item) => item.id === id);
  if (!found) throw new Error(`missing check ${id}`);
  return found;
}

function textOf(checks: DoctorCheck[]): string {
  return checks.map((item) => `${item.id} ${item.message}`).join("\n");
}

async function ephemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function sandbox(extra: Record<string, string> = {}): Promise<{ env: NodeJS.ProcessEnv; dir: string; port: number }> {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  const port = await ephemeralPort();
  return {
    dir,
    port,
    env: {
      HOST: "127.0.0.1",
      PORT: String(port),
      AUDIT_PATH: join(dir, "nested", "audit.jsonl"),
      ...extra,
    },
  };
}

function jsonResponse(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

describe("nodeVersionOk", () => {
  it("accepts 22.13 and newer", () => {
    expect(nodeVersionOk("22.13.0")).toBe(true);
    expect(nodeVersionOk("22.13")).toBe(true);
    expect(nodeVersionOk("v22.13.1")).toBe(true);
    expect(nodeVersionOk("23.0.0")).toBe(true);
    expect(nodeVersionOk("22.12.9")).toBe(false);
    expect(nodeVersionOk("21.9.0")).toBe(false);
    expect(nodeVersionOk("")).toBe(false);
  });
});

describe("doctor", () => {
  it("fails a mock-mode environment and does not call the network", async () => {
    const box = await sandbox();
    const urls: string[] = [];
    let cursorCalled = false;
    const report = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      cursorMe: async () => {
        cursorCalled = true;
      },
      fetchImpl: async (input) => {
        urls.push(String(input));
        return jsonResponse({ ok: false }, 503);
      },
    });
    expect(cursorCalled).toBe(false);
    expect(urls.some((url) => url.includes("api.github.com") || url.includes("api.x.ai"))).toBe(false);
    expect(status(report.checks, "node").status).toBe("PASS");
    expect(status(report.checks, "cursor")).toMatchObject({
      status: "FAIL",
      message: expect.stringContaining("mock mode"),
    });
    expect(status(report.checks, "github").message).toContain("PSchmidt23/demo-commercial-app");
    expect(status(report.checks, "github").message).toContain("mock mode does not");
    expect(status(report.checks, "fixture")).toMatchObject({
      status: "PASS",
      message: "fixtures/findings/cve-auth-bypass.json exists and parses.",
    });
    expect(status(report.checks, "xai")).toMatchObject({
      status: "WARN",
      message: expect.stringContaining("template summary"),
    });
    expect(status(report.checks, "port").message).toBe(`port ${box.port} is free`);
    expect(status(report.checks, "audit").message).toContain("0 incidents");
    expect(status(report.checks, "audit").message).toContain("--rerun");
    expect(report.ready).toBe(false);
    expect(report.summary).toBe(`NOT READY: ${report.failures} failures`);
    expect(report.failures).toBe(2);
    const rendered = formatDoctorText(report);
    expect(rendered.endsWith(report.summary)).toBe(true);
    expect(rendered).not.toContain(CURSOR_KEY);
  });

  it("treats a blank Cursor key as unset", async () => {
    const box = await sandbox({ CURSOR_API_KEY: "   " });
    const report = await runDoctor({
      env: box.env,
      nodeVersion: "22.14.0",
      fetchImpl: async () => jsonResponse({ ok: false }, 503),
      cursorMe: async () => {
        throw new Error("should not run");
      },
    });
    expect(status(report.checks, "cursor").status).toBe("FAIL");
    expect(status(report.checks, "cursor").message).toContain("not set");
  });

  it("verifies a Cursor key with Cursor.me and only prints a suffix", async () => {
    const box = await sandbox({ CURSOR_API_KEY: CURSOR_KEY, GITHUB_TOKEN: GITHUB_TOKEN });
    const seen: string[] = [];
    const report = await runDoctor({
      env: box.env,
      nodeVersion: "v22.13.0",
      cursorMe: async (apiKey) => {
        seen.push(apiKey);
      },
      fetchImpl: githubFetch(200),
    });
    expect(seen).toEqual([CURSOR_KEY]);
    const cursor = status(report.checks, "cursor");
    expect(cursor.status).toBe("PASS");
    expect(cursor.message).toContain("…9f3a");
    expect(cursor.message).toContain("Cursor.me succeeded");
    expect(textOf(report.checks)).not.toContain(CURSOR_KEY);
    expect(textOf(report.checks)).not.toContain("crsr_live_example");
  });

  it("redacts a rejected Cursor key", async () => {
    const box = await sandbox({ CURSOR_API_KEY: CURSOR_KEY });
    const auth = new Error(`bad ${CURSOR_KEY}`);
    auth.name = "AuthenticationError";
    const report = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      cursorMe: async () => {
        throw auth;
      },
      fetchImpl: async () => jsonResponse({ ok: false }, 503),
    });
    const cursor = status(report.checks, "cursor");
    expect(cursor.status).toBe("FAIL");
    expect(cursor.message).toContain("authentication failed");
    expect(cursor.message).not.toContain(CURSOR_KEY);
    expect(cursor.message).toContain("does not create an agent");
  });

  it("redacts a Cursor transport error and warns when no cheap read exists", async () => {
    const box = await sandbox({ CURSOR_API_KEY: CURSOR_KEY, GITHUB_TOKEN: GITHUB_TOKEN });
    const leaked = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      cursorMe: async () => {
        throw new Error(`connect ${CURSOR_KEY}`);
      },
      fetchImpl: githubFetch(200),
    });
    expect(status(leaked.checks, "cursor").message).toContain("[redacted]");
    expect(status(leaked.checks, "cursor").message).not.toContain(CURSOR_KEY);

    const unverified = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      cursorMe: async () => {
        const missing = new Error("Cursor.me is not available");
        missing.name = "NoCheapRead";
        throw missing;
      },
      fetchImpl: githubFetch(200),
    });
    expect(status(unverified.checks, "cursor")).toMatchObject({
      status: "WARN",
      message: expect.stringContaining("not verified"),
    });
    expect(unverified.ready).toBe(true);
    expect(unverified.summary).toBe("READY for live run");
  });

  it("fails when DRY_RUN would keep the server in mock mode", async () => {
    const box = await sandbox({ CURSOR_API_KEY: CURSOR_KEY, DRY_RUN: "1" });
    const report = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      cursorMe: async () => undefined,
      fetchImpl: async () => jsonResponse({ ok: false }, 503),
    });
    expect(status(report.checks, "cursor").status).toBe("FAIL");
    expect(status(report.checks, "cursor").message).toContain("DRY_RUN");
    expect(status(report.checks, "cursor").message).not.toContain(CURSOR_KEY);
  });

  it("checks the configured GitHub repo, demo branches, Actions, and pull requests", async () => {
    const box = await sandbox({
      CURSOR_API_KEY: CURSOR_KEY,
      GITHUB_TOKEN: GITHUB_TOKEN,
      DEMO_REPO_URL: "git@github.com:Acme/Widgets.git",
    });
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const report = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      cursorMe: async () => undefined,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        if (url.endsWith("/health")) return jsonResponse({ ok: false }, 503);
        return jsonResponse({});
      },
    });
    expect(calls.map((call) => call.url).filter((url) => url.includes("api.github.com"))).toEqual([
      "https://api.github.com/repos/Acme/Widgets",
      "https://api.github.com/repos/Acme/Widgets/branches/ci-fail-lint-type",
      "https://api.github.com/repos/Acme/Widgets/branches/ci-fail-test",
      "https://api.github.com/repos/Acme/Widgets/actions/runs?per_page=1",
      "https://api.github.com/repos/Acme/Widgets/pulls?per_page=1",
    ]);
    for (const call of calls.filter((item) => item.url.includes("api.github.com"))) {
      expect(call.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
    }
    expect(status(report.checks, "github").message).toContain("…zz9Q");
    expect(status(report.checks, "github.repo").status).toBe("PASS");
    expect(status(report.checks, "github.branch.ci-fail-lint-type").status).toBe("PASS");
    expect(status(report.checks, "github.branch.ci-fail-test").status).toBe("PASS");
    expect(status(report.checks, "github.actions").status).toBe("PASS");
    expect(status(report.checks, "github.pulls").status).toBe("PASS");
    expect(textOf(report.checks)).not.toContain(GITHUB_TOKEN);
    expect(textOf(report.checks)).not.toContain("ghp_test_token_");
  });

  it("names a missing demo branch and a forbidden Actions read", async () => {
    const box = await sandbox({ CURSOR_API_KEY: CURSOR_KEY, GITHUB_TOKEN: GITHUB_TOKEN });
    const report = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      cursorMe: async () => undefined,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/health")) return jsonResponse({ ok: false }, 503);
        if (url.endsWith("/branches/ci-fail-test")) return jsonResponse({}, 404);
        if (url.includes("/actions/runs")) return jsonResponse({}, 403);
        return jsonResponse({});
      },
    });
    const branch = status(report.checks, "github.branch.ci-fail-test");
    expect(branch.status).toBe("FAIL");
    expect(branch.message).toContain("HTTP 404");
    expect(branch.message).toContain("Push that demo branch");
    expect(status(report.checks, "github.actions").message).toContain("HTTP 403");
    expect(status(report.checks, "github.branch.ci-fail-lint-type").status).toBe("PASS");
    expect(report.summary).toBe("NOT READY: 2 failures");
  });

  it("redacts a GitHub client error that echoes the token", async () => {
    const box = await sandbox({ GITHUB_TOKEN: GITHUB_TOKEN });
    const report = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/pulls")) throw new Error(`socket reset ${GITHUB_TOKEN}`);
        if (url.endsWith("/health")) return jsonResponse({ ok: false }, 503);
        return jsonResponse({});
      },
    });
    const pulls = status(report.checks, "github.pulls");
    expect(pulls.status).toBe("FAIL");
    expect(pulls.message).toContain("[redacted]");
    expect(pulls.message).not.toContain(GITHUB_TOKEN);
    expect(textOf(report.checks)).not.toContain(GITHUB_TOKEN);
  });

  it("fails a missing, unparseable, or non-object scenario C fixture", async () => {
    const box = await sandbox();
    const missing = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      fixturePath: join(box.dir, "missing.json"),
      fetchImpl: async () => jsonResponse({ ok: false }, 503),
    });
    expect(status(missing.checks, "fixture").status).toBe("FAIL");
    expect(status(missing.checks, "fixture").message).toContain("missing");

    const brokenPath = join(box.dir, "broken.json");
    writeFileSync(brokenPath, "{");
    const broken = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      fixturePath: brokenPath,
      fetchImpl: async () => jsonResponse({ ok: false }, 503),
    });
    expect(status(broken.checks, "fixture").message).toContain("does not parse");

    const arrayPath = join(box.dir, "array.json");
    writeFileSync(arrayPath, "[]");
    const array = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      fixturePath: arrayPath,
      fetchImpl: async () => jsonResponse({ ok: false }, 503),
    });
    expect(status(array.checks, "fixture").message).toContain("not a JSON object");
  });

  it("warns when XAI_MODEL is absent from the model list and passes when it is present", async () => {
    const listed = await sandbox({
      CURSOR_API_KEY: CURSOR_KEY,
      GITHUB_TOKEN: GITHUB_TOKEN,
      XAI_API_KEY: XAI_KEY,
      XAI_MODEL: "grok-4",
    });
    const pass = await runDoctor({
      env: listed.env,
      nodeVersion: "22.13.0",
      cursorMe: async () => undefined,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url === "https://api.x.ai/v1/models") {
          expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${XAI_KEY}`);
          return jsonResponse({ data: [{ id: "grok-3" }, { id: "grok-4" }] });
        }
        return githubFetch(200)(input);
      },
    });
    expect(status(pass.checks, "xai").status).toBe("PASS");
    expect(status(pass.checks, "xai").message).toContain("…88aa");
    expect(status(pass.checks, "xai").message).toContain("grok-4");
    expect(textOf(pass.checks)).not.toContain(XAI_KEY);

    const missing = await runDoctor({
      env: listed.env,
      nodeVersion: "22.13.0",
      cursorMe: async () => undefined,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === "https://api.x.ai/v1/models") return jsonResponse({ data: [{ id: "grok-3" }] });
        return githubFetch(200)(input);
      },
    });
    expect(status(missing.checks, "xai").status).toBe("WARN");
    expect(status(missing.checks, "xai").message).toContain("grok-4");
    expect(missing.ready).toBe(true);
    expect(missing.warnings).toBe(1);
  });

  it("warns when the xAI key is rejected and does not call xAI when unset", async () => {
    const box = await sandbox({ XAI_API_KEY: XAI_KEY });
    const rejected = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === "https://api.x.ai/v1/models") return jsonResponse({ error: XAI_KEY }, 401);
        return jsonResponse({ ok: false }, 503);
      },
    });
    expect(status(rejected.checks, "xai").status).toBe("WARN");
    expect(status(rejected.checks, "xai").message).toContain("HTTP 401");
    expect(textOf(rejected.checks)).not.toContain(XAI_KEY);

    const urls: string[] = [];
    const unset = await sandbox();
    await runDoctor({
      env: unset.env,
      nodeVersion: "22.13.0",
      fetchImpl: async (input) => {
        urls.push(String(input));
        return jsonResponse({ ok: false }, 503);
      },
    });
    expect(urls.some((url) => url.includes("api.x.ai"))).toBe(false);
  });

  it("counts existing incidents and fails a corrupt or unwritable audit log", async () => {
    const box = await sandbox();
    const log = new AuditLog(String(box.env.AUDIT_PATH));
    log.append({ v: 1, ts: "2026-01-01T00:00:00.000Z", incidentId: "inc_1", state: "RECEIVED", type: "transition" });
    log.append({ v: 1, ts: "2026-01-01T00:00:01.000Z", incidentId: "inc_1", state: "PR_OPEN", type: "transition" });
    log.append({ v: 1, ts: "2026-01-01T00:00:02.000Z", incidentId: "inc_2", state: "ESCALATED", type: "transition" });
    const counted = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      fetchImpl: async () => jsonResponse({ ok: false }, 503),
    });
    expect(status(counted.checks, "audit").message).toContain("2 incidents");
    expect(status(counted.checks, "audit").message).toContain(String(box.env.AUDIT_PATH));
    expect(status(counted.checks, "audit").message).toContain("--rerun or deleting");

    writeFileSync(String(box.env.AUDIT_PATH), "{not json\n");
    const corrupt = await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      fetchImpl: async () => jsonResponse({ ok: false }, 503),
    });
    expect(status(corrupt.checks, "audit").status).toBe("FAIL");
    expect(status(corrupt.checks, "audit").message).toContain("--rerun or deleting");

    const blocker = join(box.dir, "not-a-directory");
    writeFileSync(blocker, "x");
    const unwritable = await runDoctor({
      env: { ...box.env, AUDIT_PATH: join(blocker, "audit.jsonl") },
      nodeVersion: "22.13.0",
      fetchImpl: async () => jsonResponse({ ok: false }, 503),
    });
    expect(status(unwritable.checks, "audit").status).toBe("FAIL");
    expect(status(unwritable.checks, "audit").message).toContain("cannot write");
  });

  it("reports a server that is already responding, and a busy port that is not", async () => {
    const up = await listen((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, mode: "mock" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const report = await runDoctor({
        env: {
          HOST: "127.0.0.1",
          PORT: String(up.port),
          AUDIT_PATH: join(mkdtempSync(join(tmpdir(), "doctor-")), "audit.jsonl"),
        },
        nodeVersion: "22.13.0",
      });
      expect(status(report.checks, "port").message).toBe(`server already responding at http://127.0.0.1:${up.port}`);
    } finally {
      await up.close();
    }

    const busy = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("other");
    });
    try {
      const report = await runDoctor({
        env: {
          HOST: "127.0.0.1",
          PORT: String(busy.port),
          AUDIT_PATH: join(mkdtempSync(join(tmpdir(), "doctor-")), "audit.jsonl"),
        },
        nodeVersion: "22.13.0",
        fetchImpl: async () => jsonResponse({ ok: false }, 503),
      });
      expect(status(report.checks, "port").status).toBe("FAIL");
      expect(status(report.checks, "port").message).toContain(`port ${busy.port} is in use`);
    } finally {
      await busy.close();
    }
  });

  it("probes loopback when HOST is 0.0.0.0", async () => {
    const box = await sandbox();
    const report = await runDoctor({
      env: { ...box.env, HOST: "0.0.0.0" },
      nodeVersion: "22.13.0",
      fetchImpl: async (input) => {
        expect(String(input)).toBe(`http://127.0.0.1:${box.port}/health`);
        return jsonResponse({ ok: true, mode: "live" });
      },
    });
    expect(status(report.checks, "port").message).toBe(`server already responding at http://127.0.0.1:${box.port}`);
  });

  it("prints JSON and exits 1 only when a check failed", async () => {
    const readyBox = await sandbox({ CURSOR_API_KEY: CURSOR_KEY, GITHUB_TOKEN: GITHUB_TOKEN });
    const readyLines: string[] = [];
    const readyCode = await main({
      argv: ["node", "doctor", "--json"],
      env: readyBox.env,
      nodeVersion: "22.13.0",
      cursorMe: async () => undefined,
      fetchImpl: githubFetch(200),
      log: (line) => readyLines.push(line),
    });
    expect(readyCode).toBe(0);
    expect(readyLines).toHaveLength(1);
    const readyBody = JSON.parse(readyLines[0] ?? "") as { ready: boolean; summary: string; checks: DoctorCheck[] };
    expect(readyBody.ready).toBe(true);
    expect(readyBody.summary).toBe("READY for live run");
    expect(JSON.stringify(readyBody)).not.toContain(CURSOR_KEY);
    expect(JSON.stringify(readyBody)).not.toContain(GITHUB_TOKEN);

    const blocked = await sandbox();
    const lines: string[] = [];
    const code = await main({
      argv: ["node", "doctor.ts"],
      env: blocked.env,
      nodeVersion: "22.12.0",
      fetchImpl: async () => jsonResponse({ ok: false }, 503),
      log: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    const rendered = lines[0] ?? "";
    expect(rendered.endsWith("NOT READY: 3 failures")).toBe(true);
    expect(rendered.startsWith("FAIL  node")).toBe(true);
    expect(rendered).toContain("PASS  fixture");
    expect(rendered).toContain("WARN  xai");
  });

  it("does not create a cloud agent", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/doctor.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/Agent\.(create|prompt|resume)\b/);
    expect(source).toContain("Cursor.me");
  });

  it("finishes the offline checklist inside the preflight budget", async () => {
    const box = await sandbox();
    const started = Date.now();
    await runDoctor({
      env: box.env,
      nodeVersion: "22.13.0",
      fetchImpl: async () => jsonResponse({ ok: false }, 503),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

function githubFetch(statusCode: number): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) return jsonResponse({ ok: false }, 503);
    return jsonResponse({}, statusCode);
  };
}

function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
