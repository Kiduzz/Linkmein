// Self-hosted entry point: one long-running process that serves the app and runs the scheduler.
import { config, linkedinConfigured } from "./config.js";
import { createApp } from "./app.js";
import { startScheduler } from "./scheduler.js";

const app = createApp();
const stopScheduler = startScheduler();

const server = app.listen(config.port, () => {
  console.log(`Linkmein running at ${config.baseUrl}`);
  if (!linkedinConfigured()) console.warn("LinkedIn is not configured: set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET (see README).");
  if (config.linkedin.dryRun) console.warn("LINKEDIN_DRY_RUN=true: posts are logged, not published.");
});

function shutdown() {
  stopScheduler();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
