import { createHmac, timingSafeEqual } from "node:crypto";
import type { CiEvidence, InboundIncident, SecurityFinding } from "./types.js";

export function signGithubBody(raw: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

export function verifyGithubSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = signGithubBody(raw, secret);
  const left = Buffer.from(header.trim());
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type ParseResult =
  | { type: "incident"; inbound: InboundIncident }
  | { type: "ignored"; reason: string }
  | { type: "rejected"; status: number; error: string };

export function parseInbound(body: unknown, githubEvent: string | undefined): ParseResult {
  if (githubEvent === "ping") return { type: "ignored", reason: "ping" };
  if (githubEvent && githubEvent !== "workflow_run" && !isEnvelope(body) && !isFinding(body)) {
    return { type: "ignored", reason: `unsupported event ${githubEvent}` };
  }

  const evidence = isRecord(body) ? asEvidence(body.evidence) : undefined;
  const deliveryId = isRecord(body) && typeof body.deliveryId === "string" ? body.deliveryId : undefined;
  const payload = isRecord(body) && isRecord(body.payload) ? body.payload : body;

  if (isFinding(payload)) {
    const finding = toFinding(payload);
    if (!finding) return { type: "rejected", status: 400, error: "security finding needs an id and a title" };
    return {
      type: "incident",
      inbound: {
        kind: "security_finding",
        deliveryId,
        repoUrl: stringField(payload, "repo") ?? stringField(payload, "repoUrl") ?? "",
        branch: stringField(payload, "branch") ?? "main",
        sha: stringField(payload, "sha"),
        title: finding.title,
        finding,
        evidence,
      },
    };
  }

  if (!isRecord(payload) || !isRecord(payload.workflow_run)) {
    return { type: "rejected", status: 400, error: "expected a workflow_run payload or a security finding" };
  }

  const run = payload.workflow_run;
  const action = stringField(payload, "action");
  const conclusion = typeof run.conclusion === "string" ? run.conclusion : null;
  if (action && action !== "completed") {
    return { type: "ignored", reason: `workflow_run action ${action}` };
  }
  if (conclusion !== "failure") {
    return { type: "ignored", reason: `workflow_run conclusion ${conclusion ?? "missing"}` };
  }

  const repository = isRecord(payload.repository) ? payload.repository : undefined;
  const fullName = repository ? stringField(repository, "full_name") : undefined;
  const repoUrl =
    (repository && stringField(repository, "html_url")) ||
    (fullName ? `https://github.com/${fullName}` : "");
  const runId = typeof run.id === "number" ? run.id : undefined;
  const branch = typeof run.head_branch === "string" ? run.head_branch : "unknown";
  const workflowName = typeof run.name === "string" ? run.name : "workflow";
  const displayTitle = typeof run.display_title === "string" ? run.display_title : undefined;

  return {
    type: "incident",
    inbound: {
      kind: "workflow_run",
      deliveryId,
      runId,
      repoUrl,
      repoFullName: fullName,
      branch,
      sha: typeof run.head_sha === "string" ? run.head_sha : undefined,
      title: displayTitle ? `${workflowName} failed on ${branch}: ${displayTitle}` : `${workflowName} failed on ${branch}`,
      workflowName,
      htmlUrl: typeof run.html_url === "string" ? run.html_url : undefined,
      evidence,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvelope(body: unknown): boolean {
  return isRecord(body) && isRecord(body.payload);
}

function isFinding(body: unknown): body is Record<string, unknown> {
  if (!isRecord(body)) return false;
  if (body.kind === "security_finding" || body.type === "security_finding") return true;
  const hasLocation = typeof body.file === "string" || typeof body.path === "string";
  const hasIdentity = typeof body.rule === "string" || typeof body.cwe === "string" || typeof body.cve === "string";
  return typeof body.id === "string" && hasLocation && hasIdentity;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toFinding(record: Record<string, unknown>): SecurityFinding | undefined {
  const id = stringField(record, "id");
  const rule = stringField(record, "rule");
  const title = stringField(record, "title") ?? [id, rule].filter((part): part is string => Boolean(part)).join(" ");
  if (!id || !title) return undefined;
  return {
    id,
    title,
    path: stringField(record, "path") ?? stringField(record, "file"),
    line: typeof record.line === "number" ? record.line : undefined,
    severity: stringField(record, "severity"),
    cve: stringField(record, "cve"),
    packageName: stringField(record, "package") ?? stringField(record, "packageName"),
    rule,
    cwe: stringField(record, "cwe"),
    description: stringField(record, "description"),
  };
}

function asEvidence(value: unknown): CiEvidence | undefined {
  if (!isRecord(value) || !Array.isArray(value.failedJobs) || !Array.isArray(value.logSnippets)) {
    return undefined;
  }
  const logSnippets = value.logSnippets.filter((line): line is string => typeof line === "string");
  const failedJobs = value.failedJobs.flatMap((job) => {
    if (!isRecord(job) || typeof job.name !== "string") return [];
    const steps = Array.isArray(job.steps)
      ? job.steps.flatMap((step) => {
          if (!isRecord(step) || typeof step.name !== "string") return [];
          return [{ name: step.name, conclusion: typeof step.conclusion === "string" ? step.conclusion : null }];
        })
      : [];
    return [{
      name: job.name,
      conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
      steps,
    }];
  });
  return { failedJobs, logSnippets };
}
