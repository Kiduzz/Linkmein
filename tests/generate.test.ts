import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRow, UserRow } from "../server/db.js";

const calls: { system: string; content: any[] }[] = [];
let reply: unknown;
vi.mock("../server/ai/claude.js", async (orig) => ({
  ...(await orig<typeof import("../server/ai/claude.js")>()),
  structured: vi.fn(async (_user: unknown, req: { system: string; content: any[] }) => {
    calls.push(req);
    return typeof reply === "function" ? (reply as () => unknown)() : reply;
  }),
}));

const { generatePosts, remixPosts } = await import("../server/ai/generate.js");

const user = { id: 1, name: "Ada" } as UserRow;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linkmein-gen-"));
const preview = path.join(dir, "p.jpg");
await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).jpeg().toFile(preview);

const media = (over: Partial<MediaRow>): MediaRow =>
  ({ id: 1, kind: "image", original_name: "a.jpg", status: "ready", preview_path: preview, frames: null, transcript: null, duration_s: null, ...over }) as MediaRow;

beforeEach(() => {
  calls.length = 0;
});

describe("generatePosts", () => {
  it("sends photos, video frames, transcripts and the author profile to Claude", async () => {
    reply = { drafts: [{ angle: "a", text: "t", rationale: "r" }], altTexts: [] };
    await generatePosts(
      user,
      { headline: "Chef", writingSamples: "my old post" },
      [
        media({ id: 1 }),
        media({ id: 2, kind: "video", frames: JSON.stringify([preview, preview]), transcript: "we opened the kitchen", duration_s: 12 }),
        media({ id: 3, kind: "audio", transcript: "voice note about our menu" }),
      ],
      { mediaIds: [1, 2, 3], notes: "Opening week", variations: 2 },
    );
    const { system, content } = calls[0];
    expect(system).toContain("Headline: Chef");
    expect(system).toContain("my old post");
    expect(content.filter((b) => b.type === "image")).toHaveLength(3);
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    expect(text).toContain("we opened the kitchen");
    expect(text).toContain("voice note about our menu");
    expect(text).toContain("Opening week");
    expect(text).toContain("exactly 2 distinct variations");
  });

  it("refuses media that is still processing", async () => {
    await expect(generatePosts(user, {}, [media({ status: "processing" })], { mediaIds: [1], notes: "" })).rejects.toThrow(/still processing/);
  });

  it("needs something to write about", async () => {
    await expect(generatePosts(user, {}, [], { mediaIds: [], notes: "  " })).rejects.toThrow(/media or notes/);
  });
});

describe("remixPosts", () => {
  const source = "I got rejected from 40 jobs last year. Here is what the 41st application taught me about writing a resume that works.";
  const inspiration = { id: 1, user_id: 1, source_text: source, source_author: "Someone", source_url: null, image_media_id: null, analysis: null, created_at: 0 };

  it("scores overlap and retries drafts that copy the reference", async () => {
    let n = 0;
    reply = () =>
      n++ === 0
        ? { drafts: [{ angle: "copy", text: source, rationale: "" }, { angle: "fresh", text: "We shipped billing on Friday after three months.", rationale: "" }] }
        : { drafts: [{ angle: "rewrite", text: "Forty rejections changed how I hire people today.", rationale: "" }, { angle: "x", text: source, rationale: "" }] };
    const drafts = await remixPosts(user, {}, inspiration, [], { inspirationId: 1, notes: "hiring", mediaIds: [], variations: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[1].content.at(-1).text).toMatch(/reused too much wording/);
    expect(drafts.map((d) => d.angle)).toEqual(["rewrite", "fresh"]);
    expect(drafts.every((d) => d.overlap < 0.12)).toBe(true);
  });
});
