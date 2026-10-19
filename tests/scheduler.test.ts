import { beforeEach, describe, expect, it } from "vitest";
import { run } from "../server/db.js";
import { LinkedInError } from "../server/linkedin.js";
import { createPostRow, getPost, MAX_ATTEMPTS, setPublisher } from "../server/posts.js";
import { recoverInterrupted, runDuePosts } from "../server/scheduler.js";
import { freshDb, makeUser } from "./helpers.js";

const input = { text: "Hello LinkedIn", mediaIds: [], visibility: "PUBLIC" as const };

describe("scheduler", () => {
  let userId: number;
  beforeEach(async () => {
    await freshDb();
    userId = (await makeUser()).id;
  });

  it("publishes due posts only", async () => {
    const published: number[] = [];
    setPublisher(async (p) => {
      published.push(p.id);
      return `urn:li:share:${p.id}`;
    });
    const due = await createPostRow(userId, input, "scheduled", Date.now() - 1000);
    const later = await createPostRow(userId, input, "scheduled", Date.now() + 3_600_000);
    const draft = await createPostRow(userId, input, "draft", null);

    expect(await runDuePosts()).toBe(1);
    expect(published).toEqual([due.id]);
    expect(await getPost(userId, due.id)).toMatchObject({ status: "published", linkedin_urn: `urn:li:share:${due.id}`, attempts: 1 });
    expect((await getPost(userId, later.id))!.status).toBe("scheduled");
    expect((await getPost(userId, draft.id))!.status).toBe("draft");

    expect(await runDuePosts()).toBe(0); // never twice
  });

  it("stops claiming posts when the time budget runs out", async () => {
    setPublisher(async (p) => {
      await new Promise((r) => setTimeout(r, 30));
      return `urn:li:share:${p.id}`;
    });
    for (let i = 0; i < 3; i++) await createPostRow(userId, input, "scheduled", Date.now() - 1000);
    expect(await runDuePosts(Date.now(), 10)).toBe(1);
    expect(await runDuePosts(Date.now())).toBe(2);
  });

  it("retries LinkedIn outages with backoff, then gives up", async () => {
    setPublisher(async () => {
      throw new LinkedInError("LinkedIn 503: unavailable", 503);
    });
    const post = await createPostRow(userId, input, "scheduled", Date.now() - 1000);

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await runDuePosts(Date.now() + attempt * 3_600_000);
      const row = (await getPost(userId, post.id))!;
      expect(row.status).toBe("scheduled");
      expect(row.attempts).toBe(attempt);
      expect(row.scheduled_at!).toBeGreaterThan(Date.now());
      expect(row.last_error).toContain("retrying");
    }
    await runDuePosts(Date.now() + 10 * 3_600_000);
    expect(await getPost(userId, post.id)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  it("fails immediately when the LinkedIn token is invalid", async () => {
    setPublisher(async () => {
      throw new LinkedInError("Reconnect LinkedIn", 401);
    });
    const post = await createPostRow(userId, input, "scheduled", Date.now() - 1000);
    await runDuePosts();
    expect(await getPost(userId, post.id)).toMatchObject({ status: "failed", last_error: "Reconnect LinkedIn" });
  });

  it("fails posts interrupted mid-publish instead of risking a duplicate", async () => {
    const post = await createPostRow(userId, input, "scheduled", Date.now());
    await run("UPDATE posts SET status = 'publishing', updated_at = ? WHERE id = ?", [Date.now() - 60 * 60_000, post.id]);
    expect(await recoverInterrupted()).toBe(1);
    expect((await getPost(userId, post.id))!.status).toBe("failed");
  });
});
