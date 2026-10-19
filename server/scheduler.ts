import { db, now } from "./db.js";
import { config } from "./config.js";
import { claimPost, publishClaimed } from "./posts.js";

const STALE_PUBLISHING_MS = 30 * 60_000;

/** Publishes every scheduled post whose time has come. Returns how many were attempted. */
export async function runDuePosts(at = now()): Promise<number> {
  const due = db()
    .prepare("SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20")
    .all(at) as { id: number }[];
  let attempted = 0;
  for (const { id } of due) {
    if (!claimPost(id, ["scheduled"])) continue;
    attempted++;
    await publishClaimed(id);
  }
  return attempted;
}

/**
 * A post stuck in "publishing" means the server stopped mid-publish. It may or may
 * not have reached LinkedIn, so we fail it rather than risk a duplicate post.
 */
export function recoverInterrupted(at = now()): number {
  return db()
    .prepare(
      `UPDATE posts SET status = 'failed', updated_at = ?,
         last_error = 'Publishing was interrupted. Check your LinkedIn profile before retrying so it isn''t posted twice.'
       WHERE status = 'publishing' AND updated_at < ?`,
    )
    .run(at, at - STALE_PUBLISHING_MS).changes;
}

export function startScheduler(): () => void {
  recoverInterrupted(now() + STALE_PUBLISHING_MS); // at startup nothing can legitimately be publishing
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
  void tick();
  return () => clearInterval(timer);
}
