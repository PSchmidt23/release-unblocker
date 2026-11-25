import { randomBytes } from "node:crypto";
import type { AuditRecord, InboundIncident } from "./types.js";

/**
 * A delivery, a workflow run, and a finding id are all keys for the same
 * incident. GitHub redelivery uses a new delivery id and the same run id,
 * so a hit on any key is a duplicate.
 */
export function dedupeKeys(inbound: InboundIncident): string[] {
  const keys: string[] = [];
  if (inbound.deliveryId) keys.push(`delivery:${inbound.deliveryId}`);
  if (inbound.kind === "workflow_run" && inbound.runId !== undefined) {
    const repo = inbound.repoFullName ?? inbound.repoUrl;
    keys.push(`run:${repo}:${inbound.runId}`);
  }
  if (inbound.kind === "security_finding" && inbound.finding?.id) {
    keys.push(`finding:${inbound.finding.id}`);
  }
  if (keys.length === 0) {
    keys.push(`delivery:unsigned:${randomBytes(6).toString("hex")}`);
  }
  return keys;
}

export function newIncidentId(): string {
  return `inc_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export class IdempotencyStore {
  private readonly byKey = new Map<string, string>();

  constructor(records: AuditRecord[]) {
    for (const record of records) {
      if (!record.dedupeKeys) continue;
      for (const key of record.dedupeKeys) {
        if (!this.byKey.has(key)) this.byKey.set(key, record.incidentId);
      }
    }
  }

  find(keys: string[]): string | undefined {
    for (const key of keys) {
      const incidentId = this.byKey.get(key);
      if (incidentId) return incidentId;
    }
    return undefined;
  }

  remember(keys: string[], incidentId: string): void {
    for (const key of keys) this.byKey.set(key, incidentId);
  }
}
