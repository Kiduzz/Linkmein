import { config } from "./config.js";
import { runDue } from "./queue.js";

/** Self-hosted: publish from a timer inside the server process. On Vercel, a cron calls /api/cron/publish instead. */
export function startScheduler(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDue();
    } catch (err) {
      console.error("Scheduler tick failed", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.schedulerIntervalMs);
  void tick();
  return () => clearInterval(timer);
}
