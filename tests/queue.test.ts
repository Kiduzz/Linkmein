import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { LinkedInError } from "../server/linkedin.js";
import { claim, enqueue, getItem, MAX_ATTEMPTS, publishClaimed, recoverInterrupted, removeItem, retryItem, runDue, setPublisher } from "../server/queue.js";
import { readJson, sizeOf, writeJson } from "../server/storage.js";
import { freshStorage, storeFile } from "./helpers.js";

const acct = "0123456789abcdef01234567";
const newId = () => crypto.randomUUID();
const post = (over: Partial<Parameters<typeof enqueue>[1]> = {}) => ({ id: newId(), text: "Hello LinkedIn", visibility: "PUBLIC" as const, dueAt: Date.now() - 1000, media: [], ...over });

beforeEach(async () => {
  await freshStorage();
  setPublisher(async (item) => `urn:li:share:${item.id}`);
});

describe("publish queue", () => {
  it("publishes due posts once, deletes their files, and leaves later ones", async () => {
    const dir = `u/${acct}/${newId()}`;
    await storeFile(`${dir}/0.jpg`, "jpeg");
    const due = await enqueue(acct, post({ media: [{ key: `${dir}/0.jpg`, kind: "image", mime: "image/jpeg" }] }));
    const later = await enqueue(acct, post({ dueAt: Date.now() + 3_600_000 }));

    expect(await runDue()).toEqual({ attempted: 1, recovered: 0 });
    expect(await getItem(acct, due.id)).toMatchObject({ status: "published", urn: `urn:li:share:${due.id}`, attempts: 1 });
    expect(await sizeOf(`${dir}/0.jpg`)).toBeNull();
    expect((await getItem(acct, later.id))!.status).toBe("scheduled");
    expect((await runDue()).attempted).toBe(0); // never twice

    const index = (await readJson<{ entries: { id: string }[] }>("queue/index.json"))!.value.entries.map((e) => e.id);
    expect(index).toEqual([later.id]);
  });

  it("lets only one run claim a post", async () => {
    const item = await enqueue(acct, post());
    const claims = await Promise.all([claim(item.id), claim(item.id), claim(item.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("retries LinkedIn outages with backoff, then gives up", async () => {
    setPublisher(async () => {
      throw new LinkedInError("LinkedIn 503: unavailable", 503);
    });
    const item = await enqueue(acct, post());
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await runDue(Date.now() + attempt * 3_600_000);
      const row = (await getItem(acct, item.id))!;
      expect(row).toMatchObject({ status: "scheduled", attempts: attempt });
      expect(row.lastError).toContain("retrying");
    }
    await runDue(Date.now() + 10 * 3_600_000);
    expect(await getItem(acct, item.id)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  it("fails immediately when the LinkedIn token is invalid, and can be retried", async () => {
    setPublisher(async () => {
      throw new LinkedInError("Reconnect LinkedIn", 401);
    });
    const item = await enqueue(acct, post());
    await runDue();
    expect(await getItem(acct, item.id)).toMatchObject({ status: "failed", lastError: "Reconnect LinkedIn" });

    setPublisher(async (i) => `urn:li:share:${i.id}`);
    await retryItem(acct, item.id);
    const claimed = await claim(item.id);
    await publishClaimed(claimed!);
    expect((await getItem(acct, item.id))!.status).toBe("published");
  });

  it("fails posts interrupted mid-publish instead of risking a duplicate", async () => {
    const item = await enqueue(acct, post());
    const claimed = (await claim(item.id))!;
    await writeJson(`queue/items/${item.id}.json`, { ...claimed, updatedAt: Date.now() - 60 * 60_000 });
    expect(await recoverInterrupted(item.id)).toBe(true);
    expect((await getItem(acct, item.id))!.status).toBe("failed");
  });

  it("stops claiming posts when the time budget runs out", async () => {
    setPublisher(async (i) => {
      await new Promise((r) => setTimeout(r, 30));
      return `urn:li:share:${i.id}`;
    });
    for (let i = 0; i < 3; i++) await enqueue(acct, post());
    expect((await runDue(Date.now(), 10)).attempted).toBe(1);
    expect((await runDue()).attempted).toBe(2);
  });

  it("validates posts and keeps accounts apart", async () => {
    await expect(enqueue(acct, post({ text: "x".repeat(3001) }))).rejects.toThrow(/3000/);
    await expect(enqueue(acct, post({ media: [{ key: `u/ffffffffffffffffffffffff/${newId()}/0.jpg`, kind: "image", mime: "image/jpeg" }] }))).rejects.toThrow(/upload key/);
    await expect(enqueue(acct, post({ media: [{ key: `u/${acct}/${newId()}/0.jpg`, kind: "image", mime: "image/jpeg" }] }))).rejects.toThrow(/didn't finish uploading/);
    const dir = `u/${acct}/${newId()}`;
    await storeFile(`${dir}/0.mp4`, "v");
    await storeFile(`${dir}/1.jpg`, "i");
    await expect(
      enqueue(acct, post({ media: [{ key: `${dir}/0.mp4`, kind: "video", mime: "video/mp4" }, { key: `${dir}/1.jpg`, kind: "image", mime: "image/jpeg" }] })),
    ).rejects.toThrow(/one video/);

    const mine = await enqueue(acct, post());
    expect(await getItem("ffffffffffffffffffffffff", mine.id)).toBeNull();
    await removeItem("ffffffffffffffffffffffff", mine.id);
    expect(await getItem(acct, mine.id)).not.toBeNull();
    await removeItem(acct, mine.id);
    expect(await getItem(acct, mine.id)).toBeNull();
  });
});
