import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { AuditLog } from "./audit.js";
import { EventHub } from "./hub.js";
import { createGitHubClient } from "./github.js";
import { acceptIncident, createRuntime, runIncident } from "./orchestrator.js";
import { parseInbound, signGithubBody } from "./webhook.js";
import type { IncidentView } from "./types.js";

const SCENARIOS = {
  A: "scenario-a.json",
  B: "scenario-b.json",
  C: "scenario-c.json",
} as const;

async function main(): Promise<void> {
  const scenario = readArg("scenario")?.toUpperCase();
  if (!scenario || !(scenario in SCENARIOS)) {
    console.error("Usage: npm run demo -- --scenario A|B|C [--dry-run] [--inline] [--rerun] [--server http://127.0.0.1:8787]");
    process.exitCode = 1;
    return;
  }
  const file = SCENARIOS[scenario as keyof typeof SCENARIOS];
  const fixturePath = fileURLToPath(new URL(`../fixtures/${file}`, import.meta.url));
  const body = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  if (process.argv.includes("--rerun") && typeof body.deliveryId === "string") {
    body.deliveryId = `${body.deliveryId}-${Date.now()}`;
  }
  const raw = Buffer.from(JSON.stringify(body));
  const inline = process.argv.includes("--inline");
  const forceDry = process.argv.includes("--dry-run");

  const view = inline ? await runInline(raw, forceDry) : await postToServer(raw, forceDry);
  printView(view);
  if (view.state === "FAILED") process.exitCode = 1;
}

async function runInline(raw: Buffer, forceDry: boolean): Promise<IncidentView> {
  const config = loadConfig();
  const runtime = createRuntime(
    config,
    createGitHubClient(config.githubToken, {
      pollAttempts: config.ciPollAttempts,
      pollIntervalMs: config.ciPollIntervalMs,
    }),
    new AuditLog(config.auditPath),
    new EventHub(),
  );
  const parsed = parseInbound(JSON.parse(raw.toString("utf8")) as unknown, undefined);
  if (parsed.type !== "incident") {
    throw new Error(parsed.type === "ignored" ? `ignored: ${parsed.reason}` : parsed.error);
  }
  const accepted = acceptIncident(runtime, parsed.inbound);
  if (accepted.duplicate) {
    console.log(`duplicate of ${accepted.incidentId} (delete ${config.auditPath} or pass --rerun)`);
  }
  return runIncident(runtime, accepted.incidentId, parsed.inbound, {
    dryRun: forceDry || config.dryRunDefault,
  });
}

async function postToServer(raw: Buffer, forceDry: boolean): Promise<IncidentView> {
  const base = readArg("server") ?? `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? "8787"}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (secret) headers["X-Hub-Signature-256"] = signGithubBody(raw, secret);
  if (forceDry) headers["X-Dry-Run"] = "1";
  let response: Response;
  try {
    response = await fetch(`${base}/webhook?wait=1`, { method: "POST", headers, body: raw });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach ${base} (${message}). Start it with npm start, or rerun with --inline.`);
  }
  const payload = (await response.json()) as {
    incident?: IncidentView;
    incidentId?: string;
    duplicate?: boolean;
    error?: string;
    reason?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? payload.reason ?? `webhook returned ${response.status}`);
  }
  if (payload.incident) return payload.incident;
  if (payload.duplicate && payload.incidentId) {
    const existing = await fetch(`${base}/api/incidents/${encodeURIComponent(payload.incidentId)}`);
    const body = (await existing.json()) as { incident?: IncidentView; error?: string };
    if (!existing.ok || !body.incident) {
      throw new Error(body.error ?? `duplicate ${payload.incidentId} could not be loaded`);
    }
    console.log(`duplicate of ${payload.incidentId}; no second agent was launched`);
    return body.incident;
  }
  throw new Error(payload.error ?? payload.reason ?? `webhook returned ${response.status}`);
}

function printView(view: IncidentView): void {
  const lines = [
    "",
    `${view.id}  ${view.state}`,
    view.title,
    view.classification
      ? `${view.classification.category}  ${view.classification.risk}  ${view.classification.policy}`
      : "unclassified",
  ];
  if (view.agent?.prUrl) lines.push(`PR ${view.agent.prUrl}${view.agent.source === "mock" ? " (simulated)" : ""}`);
  if (view.agent?.branch) lines.push(`branch ${view.agent.branch}`);
  if (view.reasons.length) lines.push(...view.reasons.map((reason) => `- ${reason}`));
  if (view.summary) {
    lines.push("", view.summary.whatBroke, view.summary.recommendedAction, `(summary: ${view.summary.source})`);
  }
  if (view.error) lines.push(view.error);
  console.log(lines.join("\n"));
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
