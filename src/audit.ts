import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditRecord } from "./types.js";

/** Append-only JSONL. Readers fold the log; nothing here rewrites a line. */
export class AuditLog {
  constructor(readonly file: string) {}

  append(record: AuditRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
  }

  readAll(): AuditRecord[] {
    if (!existsSync(this.file)) return [];
    const text = readFileSync(this.file, "utf8");
    const records: AuditRecord[] = [];
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line?.trim()) continue;
      try {
        records.push(JSON.parse(line) as AuditRecord);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Corrupt audit line ${index + 1} in ${this.file}: ${message}`);
      }
    }
    return records;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
