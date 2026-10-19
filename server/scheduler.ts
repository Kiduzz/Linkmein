import { all, now, run } from "./db.js";
import { config } from "./config.js";
import { claimPost, publishClaimed } from "./posts.js";

const STALE_PUBLISHING_MS = 30 * 60_000;

/**
 * Publishes every scheduled post whose time has come, stopping before `budgetMs`
 * so a serverless run never gets cut off halfway through a post. Returns how many
 * were attempted.
 */
export async function runDuePosts(at = now(), budgetMs = Infinity): Promise<number> {
  const started = Date.now();
  const due = await all<{ id: number }>(
    "SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20",
    [at],
  );
  let attempted = 0;
  for (const { id } of due) {
    if (Date.now() - started > budgetMs) break;
    if (!(await claimPost(id, ["scheduled"]))) continue;
    attempted++;
    await publishClaimed(id);
  }
  return attempted;
}

/**
 * A post stuck in "publishing" means the server stopped mid-publish. It may or may
 * not have reached LinkedIn, so we fail it rather than risk a duplicate post.
 */
export async function recoverInterrupted(at = now(), staleMs = STALE_PUBLISHING_MS): Promise<number> {
  const result = await run(
    `UPDATE posts SET status = 'failed', updated_at = ?,
       last_error = 'Publishing was interrupted. Check your LinkedIn profile before retrying so it isn''t posted twice.'
     WHERE status = 'publishing' AND updated_at < ?`,
    [at, at - staleMs],
  );
  return result.changes;
}

/** Self-hosted: publish from a timer inside the server process. */
export function startScheduler(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDuePosts();
    } catch (err) {
      console.error("Scheduler tick failed", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.schedulerIntervalMs);
  // At startup nothing can legitimately be publishing yet.
  void recoverInterrupted(now(), 0).then(tick, (err) => console.error("Recovering interrupted posts failed", err));
  return () => clearInterval(timer);
}
