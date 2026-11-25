import type { CiConclusion, CiEvidence, DiffFile, DiffStatus, FailedJob } from "./types.js";

export interface AgentDiff {
  files: DiffFile[];
  ci: CiConclusion;
}

export interface GitHubClient {
  readonly configured: boolean;
  fetchEvidence(repoUrl: string, runId: number): Promise<CiEvidence>;
  loadAgentDiff(input: { repoUrl: string; startingSha: string; branch: string }): Promise<AgentDiff>;
  updatePullBody(prUrl: string, body: string): Promise<void>;
}

interface GitHubOptions {
  pollAttempts: number;
  pollIntervalMs: number;
  fetchImpl?: typeof fetch;
}

const API = "https://api.github.com";

export function parseRepo(repoUrl: string): { owner: string; repo: string } | undefined {
  const cleaned = repoUrl.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const match = /github\.com[/:]([^/]+)\/([^/]+)$/.exec(cleaned);
  if (!match?.[1] || !match[2]) return undefined;
  return { owner: match[1], repo: match[2] };
}

export function parsePullNumber(prUrl: string): { owner: string; repo: string; number: number } | undefined {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(prUrl);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

const INTERESTING = /error|FAIL|TS\d{3,}|AssertionError|CONFLICT|eslint/i;
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function snippetsFromLog(log: string): string[] {
  const lines = log
    .slice(0, 200_000)
    .split("\n")
    .map(cleanLogLine)
    .filter((line) => line.length > 0);
  const hits: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !INTERESTING.test(line)) continue;
    const previous = lines[index - 1];
    if (previous && /(?:^|\/)(?:src|auth|migrations|infra)\//.test(previous) && !INTERESTING.test(previous)) {
      hits.push(previous.slice(0, 400));
    }
    hits.push(line.slice(0, 400));
  }
  return hits.slice(0, 30);
}

function cleanLogLine(line: string): string {
  return line
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "")
    .replace(/^##\[(?:error|warning|group|endgroup)\]/, "")
    .replace(ansi, "")
    .trim();
}

function mapStatus(status: string): DiffStatus {
  if (status === "added" || status === "removed" || status === "renamed" || status === "modified") {
    return status;
  }
  return "modified";
}

export function filesFromCompare(payload: unknown): DiffFile[] {
  if (!payload || typeof payload !== "object") return [];
  const files = (payload as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  const mapped: DiffFile[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const row = file as {
      filename?: unknown;
      status?: unknown;
      additions?: unknown;
      deletions?: unknown;
      patch?: unknown;
    };
    if (typeof row.filename !== "string") continue;
    if (row.status === "unchanged") continue;
    mapped.push({
      filename: row.filename,
      status: mapStatus(typeof row.status === "string" ? row.status : "modified"),
      additions: typeof row.additions === "number" ? row.additions : 0,
      deletions: typeof row.deletions === "number" ? row.deletions : 0,
      patch: typeof row.patch === "string" ? row.patch : undefined,
    });
  }
  return mapped;
}

function mapCombinedState(state: string | undefined): CiConclusion {
  if (state === "success") return "success";
  if (state === "pending") return "pending";
  if (state === "failure" || state === "error") return "failure";
  return "unknown";
}

export function createGitHubClient(token: string | undefined, options: GitHubOptions): GitHubClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "release-unblocker",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function get(path: string): Promise<Response> {
    return fetchImpl(`${API}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
  }

  return {
    configured: Boolean(token),

    async fetchEvidence(repoUrl, runId) {
      const repo = requireRepo(repoUrl);
      const jobsResponse = await get(`/repos/${repo.owner}/${repo.repo}/actions/runs/${runId}/jobs?per_page=100`);
      if (!jobsResponse.ok) {
        throw new Error(`GitHub jobs ${jobsResponse.status} for run ${runId}`);
      }
      const body = (await jobsResponse.json()) as { jobs?: unknown };
      const failedJobs = parseJobs(body.jobs).filter((job) => job.conclusion === "failure");
      const snippets: string[] = [];
      for (const job of failedJobs) {
        if (job.id === undefined) continue;
        const logs = await get(`/repos/${repo.owner}/${repo.repo}/actions/jobs/${job.id}/logs`);
        if (!logs.ok) continue;
        snippets.push(...snippetsFromLog(await logs.text()));
      }
      return { failedJobs, logSnippets: snippets.slice(0, 30) };
    },

    async loadAgentDiff({ repoUrl, startingSha, branch }) {
      const repo = requireRepo(repoUrl);
      const comparePath = `/repos/${repo.owner}/${repo.repo}/compare/${encodeURIComponent(startingSha)}...${encodeURIComponent(branch)}`;
      const compareResponse = await get(comparePath);
      if (!compareResponse.ok) {
        throw new Error(`GitHub compare ${compareResponse.status} for ${startingSha}...${branch}`);
      }
      const files = filesFromCompare(await compareResponse.json());
      const ci = await pollStatus(get, repo, branch, options.pollAttempts, options.pollIntervalMs);
      return { files, ci };
    },

    async updatePullBody(prUrl, body) {
      const pull = parsePullNumber(prUrl);
      if (!pull) throw new Error(`Not a GitHub pull URL: ${prUrl}`);
      const response = await fetchImpl(`${API}/repos/${pull.owner}/${pull.repo}/pulls/${pull.number}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`GitHub pull update ${response.status}`);
      }
    },
  };
}

function requireRepo(repoUrl: string): { owner: string; repo: string } {
  const repo = parseRepo(repoUrl);
  if (!repo) throw new Error(`Cannot parse GitHub repo from ${repoUrl}`);
  return repo;
}

function parseJobs(value: unknown): Array<FailedJob & { id?: number }> {
  if (!Array.isArray(value)) return [];
  const jobs: Array<FailedJob & { id?: number }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const job = item as { id?: unknown; name?: unknown; conclusion?: unknown; steps?: unknown };
    if (typeof job.name !== "string") continue;
    const steps = Array.isArray(job.steps)
      ? job.steps.flatMap((step) => {
          if (!step || typeof step !== "object") return [];
          const row = step as { name?: unknown; conclusion?: unknown };
          if (typeof row.name !== "string") return [];
          return [{ name: row.name, conclusion: typeof row.conclusion === "string" ? row.conclusion : null }];
        })
      : [];
    jobs.push({
      id: typeof job.id === "number" ? job.id : undefined,
      name: job.name,
      conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
      steps,
    });
  }
  return jobs;
}

async function pollStatus(
  get: (path: string) => Promise<Response>,
  repo: { owner: string; repo: string },
  ref: string,
  attempts: number,
  intervalMs: number,
): Promise<CiConclusion> {
  let latest: CiConclusion = "unknown";
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const response = await get(`/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}/status`);
    if (response.ok) {
      const body = (await response.json()) as { state?: string };
      latest = mapCombinedState(body.state);
      if (latest === "success" || latest === "failure") return latest;
    } else {
      latest = "unknown";
    }
    if (attempt < attempts - 1 && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return latest;
}
