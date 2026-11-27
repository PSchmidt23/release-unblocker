/**
 * Preflight for a live (non-mock) demo. Prints a PASS/WARN/FAIL checklist.
 *
 * Verified against @cursor/sdk 1.5.0: `Cursor.me({ apiKey })` is an
 * authenticated account read. This file does not create a cloud agent.
 * When that read is missing, the key is reported as set but not verified.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { AuditLog } from "./audit.js";
import { parseRepo } from "./github.js";
import { foldIncidents } from "./incidents.js";

const MIN_NODE = "22.13.0";
const DEMO_BRANCHES = ["ci-fail-lint-type", "ci-fail-test"] as const;
const FIXTURE_LABEL = "fixtures/findings/cve-auth-bypass.json";
const GITHUB_API = "https://api.github.com";
const XAI_MODELS_URL = "https://api.x.ai/v1/models";
const NET_TIMEOUT_MS = 4_000;
const CURSOR_TIMEOUT_MS = 5_000;

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
}

export interface DoctorReport {
  ready: boolean;
  failures: number;
  warnings: number;
  summary: string;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  cursorMe: (apiKey: string) => Promise<void>;
  nodeVersion: string;
  fixturePath: string;
  fixtureLabel: string;
}

export function defaultFixturePath(): string {
  return fileURLToPath(new URL("../fixtures/findings/cve-auth-bypass.json", import.meta.url));
}

export async function runDoctor(overrides: Partial<DoctorDeps> = {}): Promise<DoctorReport> {
  const env = overrides.env ?? process.env;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const cursorMe = overrides.cursorMe ?? defaultCursorMe;
  const nodeVersion = overrides.nodeVersion ?? process.versions.node;
  const fixturePath = overrides.fixturePath ?? defaultFixturePath();
  const fixtureLabel = overrides.fixtureLabel ?? (overrides.fixturePath ? fixturePath : FIXTURE_LABEL);
  const config = loadConfig(env);

  const [nodeCheck, cursorCheck, githubChecks, fixtureCheck, xaiCheck, portCheck, auditCheck] = await Promise.all([
    Promise.resolve(checkNode(nodeVersion)),
    checkCursor(config.cursorApiKey, Boolean(config.cursorApiKey) && config.dryRunDefault, cursorMe),
    checkGitHub(config.githubToken, config.demoRepoUrl, fetchImpl),
    Promise.resolve(checkFixture(fixturePath, fixtureLabel)),
    checkXai(config.xaiApiKey, config.xaiModel, fetchImpl),
    checkPort(config.host, config.port, fetchImpl),
    Promise.resolve(checkAudit(config.auditPath)),
  ]);

  return summarize([
    nodeCheck,
    cursorCheck,
    ...githubChecks,
    fixtureCheck,
    xaiCheck,
    portCheck,
    auditCheck,
  ]);
}

export function formatDoctorText(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((item) => item.id.length), 4);
  const lines = report.checks.map((item) => `${item.status.padEnd(4)}  ${item.id.padEnd(width)}  ${item.message}`);
  return [...lines, report.summary].join("\n");
}

export function formatDoctor(report: DoctorReport, json = false): string {
  return json ? JSON.stringify(report, null, 2) : formatDoctorText(report);
}

export async function main(options: Partial<DoctorDeps> & { argv?: readonly string[]; log?: (line: string) => void } = {}): Promise<number> {
  const report = await runDoctor(options);
  const json = (options.argv ?? process.argv).includes("--json");
  (options.log ?? console.log)(formatDoctor(report, json));
  return report.ready ? 0 : 1;
}

export function nodeVersionOk(version: string, minimum = MIN_NODE): boolean {
  const got = parseVersion(version);
  const need = parseVersion(minimum);
  for (let index = 0; index < 3; index += 1) {
    const left = got[index] ?? 0;
    const right = need[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function summarize(checks: DoctorCheck[]): DoctorReport {
  const failures = checks.filter((item) => item.status === "FAIL").length;
  const warnings = checks.filter((item) => item.status === "WARN").length;
  const ready = failures === 0;
  const summary = ready ? "READY for live run" : `NOT READY: ${failures} failures`;
  return { ready, failures, warnings, summary, checks };
}

function checkNode(version: string): DoctorCheck {
  if (nodeVersionOk(version)) {
    return check("node", "PASS", `Node ${version} (>= 22.13)`);
  }
  return check("node", "FAIL", `Node ${version} is older than 22.13. Install Node 22.13 or newer.`);
}

async function checkCursor(
  apiKey: string | undefined,
  mockForced: boolean,
  cursorMe: (apiKey: string) => Promise<void>,
): Promise<DoctorCheck> {
  if (!apiKey) {
    return check(
      "cursor",
      "FAIL",
      "CURSOR_API_KEY is not set. The server stays in mock mode. Export a Cursor user or service-account key for a live run.",
    );
  }
  const masked = maskSecret(apiKey);
  try {
    await withTimeout(cursorMe(apiKey), CURSOR_TIMEOUT_MS, "Cursor.me");
  } catch (error) {
    if (error instanceof Error && error.name === "NoCheapRead") {
      if (mockForced) {
        return check(
          "cursor",
          "FAIL",
          `CURSOR_API_KEY is ${masked} but not verified, and DRY_RUN forces mock mode. Unset DRY_RUN. Doctor does not create an agent.`,
        );
      }
      return check(
        "cursor",
        "WARN",
        `CURSOR_API_KEY is ${masked} but not verified. @cursor/sdk has no cheap account read, and doctor will not create an agent.`,
      );
    }
    const detail = cursorFailure(error, apiKey);
    return check(
      "cursor",
      "FAIL",
      `CURSOR_API_KEY is ${masked} but Cursor.me failed (${detail}). Export a valid key. Doctor does not create an agent.`,
    );
  }
  if (mockForced) {
    return check(
      "cursor",
      "FAIL",
      `CURSOR_API_KEY is ${masked} and Cursor.me succeeded, but DRY_RUN forces mock mode. Unset DRY_RUN for a live run.`,
    );
  }
  return check("cursor", "PASS", `CURSOR_API_KEY is ${masked} and Cursor.me succeeded.`);
}

async function defaultCursorMe(apiKey: string): Promise<void> {
  const sdk = await import("@cursor/sdk");
  if (typeof sdk.Cursor?.me !== "function") {
    const missing = new Error("Cursor.me is not available");
    missing.name = "NoCheapRead";
    throw missing;
  }
  await sdk.Cursor.me({ apiKey });
}

async function checkGitHub(
  token: string | undefined,
  repoUrl: string,
  fetchImpl: typeof fetch,
): Promise<DoctorCheck[]> {
  const parsed = parseRepo(repoUrl);
  const slug = parsed ? `${parsed.owner}/${parsed.repo}` : repoUrl;
  if (!token) {
    return [
      check(
        "github",
        "FAIL",
        `GITHUB_TOKEN is not set. Export a token that can read ${slug}, Actions, and pull requests. Live gates need it; mock mode does not.`,
      ),
    ];
  }
  if (!parsed) {
    return [
      check(
        "github",
        "FAIL",
        `DEMO_REPO_URL is not a github.com owner/repo URL (${clip(redact(oneLine(repoUrl), token))}). Set DEMO_REPO_URL. GITHUB_TOKEN is ${maskSecret(token)}.`,
      ),
    ];
  }
  const masked = maskSecret(token);
  const base = `/repos/${parsed.owner}/${parsed.repo}`;
  const probes: Probe[] = [
    {
      id: "github.repo",
      path: base,
      ok: `${slug} is visible`,
      what: `repo ${slug}`,
    },
    ...DEMO_BRANCHES.map((branch) => ({
      id: `github.branch.${branch}`,
      path: `${base}/branches/${encodeURIComponent(branch)}`,
      ok: `branch ${branch} exists`,
      what: `branch ${branch}`,
    })),
    {
      id: "github.actions",
      path: `${base}/actions/runs?per_page=1`,
      ok: "Actions runs are readable",
      what: "Actions read",
    },
    {
      id: "github.pulls",
      path: `${base}/pulls?per_page=1`,
      ok: "pull requests are readable",
      what: "pull request read",
    },
  ];
  const results = await Promise.all(probes.map((probe) => runProbe(fetchImpl, token, probe)));
  return [check("github", "PASS", `GITHUB_TOKEN is ${masked}.`), ...results];
}

interface Probe {
  id: string;
  path: string;
  ok: string;
  what: string;
}

async function runProbe(fetchImpl: typeof fetch, token: string, probe: Probe): Promise<DoctorCheck> {
  const result = await githubGet(fetchImpl, token, probe.path);
  if (result.ok) return check(probe.id, "PASS", probe.ok);
  return check(probe.id, "FAIL", probeHint(probe, result.status, result.error, token));
}

async function githubGet(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const response = await fetchImpl(`${GITHUB_API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "release-unblocker",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, error: message };
  }
}

function checkFixture(filePath: string, label: string): DoctorCheck {
  if (!existsSync(filePath)) {
    return check("fixture", "FAIL", `${label} is missing. Restore the scenario C finding fixture.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return check("fixture", "FAIL", `${label} does not parse (${oneLine(message)}). Restore valid JSON for scenario C.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return check("fixture", "FAIL", `${label} is not a JSON object. Replace it with the scenario C finding.`);
  }
  return check("fixture", "PASS", `${label} exists and parses.`);
}

async function checkXai(apiKey: string | undefined, model: string, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  if (!apiKey) {
    return check(
      "xai",
      "WARN",
      "XAI_API_KEY is not set. The template summary will be used. Export it to verify Grok, or leave it unset.",
    );
  }
  const masked = maskSecret(apiKey);
  try {
    const response = await fetchImpl(XAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    });
    if (!response.ok) {
      return check(
        "xai",
        "WARN",
        `XAI_API_KEY is ${masked} but GET /v1/models returned HTTP ${response.status}. Fix the key or unset it; the template summary will be used.`,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return check(
        "xai",
        "WARN",
        `XAI_API_KEY is ${masked} but the model list was not JSON. Confirm XAI_MODEL=${model} or unset the key; the template summary will be used.`,
      );
    }
    const ids = modelIds(body);
    if (!ids.includes(model)) {
      return check(
        "xai",
        "WARN",
        `XAI_MODEL ${model} is not in the xAI model list. Set XAI_MODEL to a listed model or unset XAI_API_KEY; the template summary will be used.`,
      );
    }
    return check("xai", "PASS", `XAI_API_KEY is ${masked} and XAI_MODEL ${model} is listed.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return check(
      "xai",
      "WARN",
      `XAI_API_KEY is ${masked} but GET /v1/models failed (${redact(oneLine(message), apiKey)}). Unset it to use the template summary.`,
    );
  }
}

async function checkPort(host: string, port: number, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const base = `http://${probeHost}:${port}`;
  if (await healthResponding(fetchImpl, `${base}/health`)) {
    return check("port", "PASS", `server already responding at ${base}`);
  }
  const free = await canListen(host, port);
  if (free) return check("port", "PASS", `port ${port} is free`);
  return check(
    "port",
    "FAIL",
    `port ${port} is in use and ${base} did not respond. Stop the other process or set PORT.`,
  );
}

async function healthResponding(fetchImpl: typeof fetch, url: string): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const body = (await response.json()) as unknown;
    return Boolean(body && typeof body === "object" && (body as { ok?: unknown }).ok === true);
  } catch {
    return false;
  }
}

function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    let settled = false;
    const finish = (free: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!server.listening) {
        resolvePromise(free);
        return;
      }
      server.close(() => resolvePromise(free));
    };
    const timer = setTimeout(() => finish(false), 1_500);
    server.once("error", () => finish(false));
    server.listen({ port, host, exclusive: true }, () => finish(true));
  });
}

function checkAudit(auditPath: string): DoctorCheck {
  const dir = dirname(auditPath);
  const probe = join(dir, `.doctor-write-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return check("audit", "FAIL", `cannot write ${dir}/ for ${auditPath} (${oneLine(message)}). Make the directory writable.`);
  } finally {
    try {
      if (existsSync(probe)) unlinkSync(probe);
    } catch {
      // The writability result is already decided. A leftover probe is not an incident.
    }
  }
  if (existsSync(auditPath)) {
    try {
      const incidents = foldIncidents(new AuditLog(auditPath).readAll()).length;
      return check("audit", "PASS", auditMessage(dir, auditPath, incidents));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return check(
        "audit",
        "FAIL",
        `${auditPath} could not be read (${oneLine(message)}). Fix the JSONL or delete it. --rerun or deleting ${auditPath} resets.`,
      );
    }
  }
  return check("audit", "PASS", auditMessage(dir, auditPath, 0));
}

function auditMessage(dir: string, auditPath: string, incidents: number): string {
  const noun = incidents === 1 ? "incident" : "incidents";
  return `${dir}/ is writable; ${incidents} ${noun} in ${auditPath}. --rerun or deleting ${auditPath} resets.`;
}

function modelIds(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    if (typeof item === "string") ids.push(item);
    else if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      ids.push((item as { id: string }).id);
    }
  }
  return ids;
}

function probeHint(probe: Probe, status: number, error: string | undefined, secret: string): string {
  const problem = httpHint(probe.what, status, error, secret);
  if (error) return `${problem} Check the network and retry.`;
  if (status === 404 && probe.id.startsWith("github.branch.")) {
    return `${problem} Push that demo branch or point DEMO_REPO_URL at the Northstar repo.`;
  }
  if (status === 404 && probe.id === "github.repo") {
    return `${problem} Check DEMO_REPO_URL and that the token can see the repo.`;
  }
  if (status === 401 || status === 403) {
    return `${problem} Export a token that can read the repo, Actions, and pull requests.`;
  }
  return `${problem} Check the token scopes and DEMO_REPO_URL.`;
}

function httpHint(what: string, status: number, error: string | undefined, secret: string): string {
  if (error) return `${what} failed (${redact(oneLine(error), secret)}).`;
  if (status === 401) return `${what} rejected the token (HTTP 401).`;
  if (status === 403) return `${what} is forbidden (HTTP 403).`;
  if (status === 404) return `${what} was not found (HTTP 404).`;
  return `${what} failed (HTTP ${status}).`;
}

function cursorFailure(error: unknown, secret: string): string {
  if (error instanceof Error && error.name === "AuthenticationError") return "authentication failed";
  const message = error instanceof Error ? error.message : String(error);
  return redact(oneLine(message), secret);
}

function maskSecret(value: string): string {
  if (value.length < 8) return "set";
  return `set (…${value.slice(-4)})`;
}

function redact(message: string, secret: string | undefined): string {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max = 180): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function check(id: string, status: CheckStatus, message: string): DoctorCheck {
  return { id, status, message };
}

function parseVersion(value: string): [number, number, number] {
  const parts = value.trim().replace(/^v/, "").split(".");
  const num = (index: number): number => {
    const parsed = Number.parseInt(parts[index] ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [num(0), num(1), num(2)];
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
