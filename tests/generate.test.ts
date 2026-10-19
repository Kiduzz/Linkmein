import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredMedia } from "../web/src/local/db";
import type { AiContext } from "../web/src/ai/claude";

const calls: { system: string; content: any[] }[] = [];
let reply: unknown;
vi.mock("../web/src/ai/claude", async (orig) => ({
  ...(await orig<typeof import("../web/src/ai/claude")>()),
  structured: vi.fn(async (_user: unknown, req: { system: string; content: any[] }) => {
    calls.push(req);
    return typeof reply === "function" ? (reply as () => unknown)() : reply;
  }),
}));

const { generatePosts, remixPosts } = await import("../web/src/ai/generate");

const user: AiContext = { name: "Ada", apiKey: "sk-test", model: "claude-opus-5-5" };
const preview = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });

const media = (over: Partial<StoredMedia>): StoredMedia =>
  ({ id: 1, kind: "image", name: "a.jpg", status: "ready", preview, frames: [], blob: preview, transcript: null, durationS: null, ...over }) as StoredMedia;

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
        media({ id: 2, kind: "video", frames: [preview, preview], transcript: "we opened the kitchen", durationS: 12 }),
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

  it("refuses media that is still being transcribed", async () => {
    await expect(generatePosts(user, {}, [media({ kind: "audio", status: "processing" })], { mediaIds: [1], notes: "" })).rejects.toThrow(/still being transcribed/);
  });

  it("needs something to write about", async () => {
    await expect(generatePosts(user, {}, [], { mediaIds: [], notes: "  " })).rejects.toThrow(/media or notes/);
  });
});

describe("remixPosts", () => {
  const source = "I got rejected from 40 jobs last year. Here is what the 41st application taught me about writing a resume that works.";
  const inspiration = { id: 1, text: source, author: "Someone", url: null, screenshotMediaId: null, analysis: null, createdAt: 0 };

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
