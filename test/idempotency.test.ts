import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IdempotencyStore, dedupeKeys } from "../src/idempotency.js";
import { signGithubBody, verifyGithubSignature } from "../src/webhook.js";
import { createApp } from "../src/app.js";
import { foldIncidents } from "../src/incidents.js";
import { tempRuntime } from "./helpers.js";
import type { AddressInfo } from "node:net";
import type { Runtime } from "../src/orchestrator.js";

function fixture(name: string): Buffer {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return Buffer.from(readFileSync(path));
}

async function listen(runtime: Runtime): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createApp(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe("idempotency", () => {
  it("treats delivery, run, and finding ids as the same incident", () => {
    const store = new IdempotencyStore([]);
    const keys = dedupeKeys({
      kind: "workflow_run",
      deliveryId: "d-1",
      runId: 1001,
      repoUrl: "https://github.com/PSchmidt23/demo-commercial-app",
      repoFullName: "PSchmidt23/demo-commercial-app",
      branch: "ci-fail-lint-type",
      title: "CI failed",
    });
    store.remember(keys, "inc_a");
    expect(store.find(["delivery:d-1"])).toBe("inc_a");
    expect(store.find(["run:PSchmidt23/demo-commercial-app:1001"])).toBe("inc_a");
    expect(store.find(["finding:other"])).toBeUndefined();

    const rebuilt = new IdempotencyStore([
      {
        v: 1,
        ts: new Date().toISOString(),
        incidentId: "inc_a",
        state: "RECEIVED",
        type: "transition",
        dedupeKeys: keys,
      },
    ]);
    expect(rebuilt.find(["run:PSchmidt23/demo-commercial-app:1001"])).toBe("inc_a");
  });

  it("verifies GitHub signatures and rejects a mismatched length", () => {
    const body = Buffer.from('{"ok":true}');
    const secret = "shh";
    const signature = signGithubBody(body, secret);
    expect(verifyGithubSignature(body, signature, secret)).toBe(true);
    expect(verifyGithubSignature(body, signature, "other")).toBe(false);
    expect(verifyGithubSignature(body, "sha256=abc", secret)).toBe(false);
    expect(verifyGithubSignature(body, undefined, secret)).toBe(false);
  });

  it("dedupes a repeated webhook and refuses a bad signature", async () => {
    const open = await listen(tempRuntime());
    const body = fixture("scenario-a.json");
    const first = await fetch(`${open.base}/webhook?wait=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const firstBody = (await first.json()) as { incidentId: string; duplicate: boolean; state: string };
    expect(first.status).toBe(200);
    expect(firstBody.duplicate).toBe(false);
    expect(firstBody.state).toBe("AUTO_FIXED");

    const second = await fetch(`${open.base}/webhook?wait=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Delivery": "another-delivery" },
      body,
    });
    const secondBody = (await second.json()) as { incidentId: string; duplicate: boolean };
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.incidentId).toBe(firstBody.incidentId);

    const parallelBody = fixture("scenario-b.json");
    const [left, right] = await Promise.all([
      fetch(`${open.base}/webhook?wait=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: Buffer.from(parallelBody) }),
      fetch(`${open.base}/webhook?wait=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: Buffer.from(parallelBody) }),
    ]);
    const leftJson = (await left.json()) as { incidentId: string; duplicate: boolean };
    const rightJson = (await right.json()) as { incidentId: string; duplicate: boolean };
    expect(leftJson.incidentId).toBe(rightJson.incidentId);
    expect([leftJson.duplicate, rightJson.duplicate].filter(Boolean)).toHaveLength(1);

    await open.close();
  });

  it("does not record an incident when the signature is wrong", async () => {
    const runtime = tempRuntime({ GITHUB_WEBHOOK_SECRET: "top-secret" });
    const open = await listen(runtime);
    const body = fixture("scenario-c.json");
    const missing = await fetch(`${open.base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(missing.status).toBe(401);

    const signed = await fetch(`${open.base}/webhook?wait=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signGithubBody(body, "top-secret"),
      },
      body,
    });
    expect(signed.status).toBe(200);
    const incidents = foldIncidents(runtime.audit.readAll());
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.state).toBe("ESCALATED");
    await open.close();
  });
});
