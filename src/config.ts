export interface AppConfig {
  port: number;
  host: string;
  cursorApiKey?: string;
  cursorModel: string;
  githubToken?: string;
  githubWebhookSecret?: string;
  xaiApiKey?: string;
  xaiModel: string;
  auditPath: string;
  demoRepoUrl: string;
  /** True when live agents must not be launched. */
  dryRunDefault: boolean;
  ciPollAttempts: number;
  ciPollIntervalMs: number;
  mockStreamDelayMs: number;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function intFrom(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cursorApiKey = emptyToUndefined(env.CURSOR_API_KEY);
  const forceDry = env.DRY_RUN === "1" || env.DRY_RUN === "true";
  return {
    port: intFrom(env.PORT, 8787),
    host: emptyToUndefined(env.HOST) ?? "127.0.0.1",
    cursorApiKey,
    cursorModel: emptyToUndefined(env.CURSOR_MODEL) ?? "composer-2.5",
    githubToken: emptyToUndefined(env.GITHUB_TOKEN),
    githubWebhookSecret: emptyToUndefined(env.GITHUB_WEBHOOK_SECRET),
    xaiApiKey: emptyToUndefined(env.XAI_API_KEY),
    xaiModel: emptyToUndefined(env.XAI_MODEL) ?? "grok-4.7",
    auditPath: emptyToUndefined(env.AUDIT_PATH) ?? "data/audit.jsonl",
    demoRepoUrl:
      emptyToUndefined(env.DEMO_REPO_URL) ?? "https://github.com/PSchmidt23/demo-commercial-app",
    dryRunDefault: forceDry || !cursorApiKey,
    ciPollAttempts: intFrom(env.CI_POLL_ATTEMPTS, 3),
    ciPollIntervalMs: intFrom(env.CI_POLL_INTERVAL_MS, 4000),
    mockStreamDelayMs: intFrom(env.MOCK_STREAM_DELAY_MS, 40),
  };
}
