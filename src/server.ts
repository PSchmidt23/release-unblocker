import { loadConfig } from "./config.js";
import { AuditLog } from "./audit.js";
import { EventHub } from "./hub.js";
import { createGitHubClient } from "./github.js";
import { createRuntime } from "./orchestrator.js";
import { createApp } from "./app.js";

const config = loadConfig();
const audit = new AuditLog(config.auditPath);
const github = createGitHubClient(config.githubToken, {
  pollAttempts: config.ciPollAttempts,
  pollIntervalMs: config.ciPollIntervalMs,
});
const runtime = createRuntime(config, github, audit, new EventHub());
const server = createApp(runtime);

server.listen(config.port, config.host, () => {
  const mode = config.dryRunDefault ? "mock (no live agent)" : "live";
  console.log(`[release-unblocker] http://${config.host}:${config.port}`);
  console.log(`[release-unblocker] mode ${mode}; model ${config.cursorModel}`);
  console.log(`[release-unblocker] audit ${config.auditPath}`);
  console.log(`[release-unblocker] grok ${config.xaiApiKey ? config.xaiModel : "off (template summaries)"}`);
  console.log(`[release-unblocker] github reads ${github.configured ? "on" : "off"}`);
});
