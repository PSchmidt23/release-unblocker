import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { acceptIncident, runIncident, type Runtime } from "./orchestrator.js";
import { findIncident, foldIncidents } from "./incidents.js";
import { parseInbound, verifyGithubSignature } from "./webhook.js";
import type { InboundIncident } from "./types.js";

function dashboardHtml(): string {
  return readFileSync(fileURLToPath(new URL("./dashboard.html", import.meta.url)), "utf8");
}

export function createApp(runtime: Runtime): Server {
  return createServer((req, res) => {
    void handle(runtime, req, res).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === "payload too large" ? 413 : 500;
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    });
  });
}

async function handle(runtime: Runtime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHtml());
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, mode: runtime.config.dryRunDefault ? "mock" : "live" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/meta") {
    sendJson(res, 200, meta(runtime));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/incidents") {
    sendJson(res, 200, { incidents: foldIncidents(runtime.audit.readAll()) });
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/incidents/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/incidents/".length));
    const incident = findIncident(runtime.audit.readAll(), id);
    if (!incident) {
      sendJson(res, 404, { error: "incident not found" });
      return;
    }
    sendJson(res, 200, { incident });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    streamEvents(runtime, res, url.searchParams.get("incidentId"));
    return;
  }
  if (req.method === "POST" && url.pathname === "/webhook") {
    await postWebhook(runtime, req, res, url);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

async function postWebhook(runtime: Runtime, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const raw = await readBody(req);
  const secret = runtime.config.githubWebhookSecret;
  if (secret) {
    const header = headerString(req, "x-hub-signature-256");
    if (!verifyGithubSignature(raw, header, secret)) {
      sendJson(res, 401, { error: "invalid webhook signature" });
      return;
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    sendJson(res, 400, { error: "body is not JSON" });
    return;
  }
  const parsed = parseInbound(json, headerString(req, "x-github-event"));
  if (parsed.type === "ignored") {
    sendJson(res, 200, { ignored: true, reason: parsed.reason });
    return;
  }
  if (parsed.type === "rejected") {
    sendJson(res, parsed.status, { error: parsed.error });
    return;
  }
  const inbound = applyDeliveryHeader(parsed.inbound, headerString(req, "x-github-delivery"));
  const accepted = acceptIncident(runtime, inbound);
  if (accepted.duplicate) {
    const incident = findIncident(runtime.audit.readAll(), accepted.incidentId);
    sendJson(res, 200, { incidentId: accepted.incidentId, duplicate: true, state: incident?.state });
    return;
  }
  const dryRun = headerString(req, "x-dry-run") === "1" || runtime.config.dryRunDefault;
  const wait = url.searchParams.get("wait") === "1";
  const run = () => runIncident(runtime, accepted.incidentId, inbound, { dryRun });
  if (!wait) {
    void run().catch((error) => {
      console.error(`[release-unblocker] ${accepted.incidentId} failed after accept`, error);
    });
    sendJson(res, 202, { incidentId: accepted.incidentId, duplicate: false, state: "RECEIVED" });
    return;
  }
  const incident = await run();
  sendJson(res, 200, { incidentId: incident.id, duplicate: false, state: incident.state, incident });
}

function applyDeliveryHeader(inbound: InboundIncident, delivery: string | undefined): InboundIncident {
  if (inbound.deliveryId || !delivery) return inbound;
  return { ...inbound, deliveryId: delivery };
}

function streamEvents(runtime: Runtime, res: ServerResponse, incidentId: string | null): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": ok\n\n");
  const unsubscribe = runtime.hub.subscribe((event) => {
    if (incidentId && event.incidentId !== incidentId) return;
    res.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function meta(runtime: Runtime) {
  return {
    mode: runtime.config.dryRunDefault ? "mock" : "live",
    model: runtime.config.cursorModel,
    grok: Boolean(runtime.config.xaiApiKey),
    grokModel: runtime.config.xaiModel,
    repo: runtime.config.demoRepoUrl,
    github: runtime.github.configured,
    signatureRequired: Boolean(runtime.config.githubWebhookSecret),
  };
}

function headerString(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
