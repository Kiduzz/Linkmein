import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { setPublisher } from "../server/posts.js";
import { freshDb } from "./helpers.js";

const app = createApp();
const H = { "X-Linkmein": "1" };

async function login() {
  const agent = request.agent(app);
  await agent.post("/auth/dev-login").set(H).expect(200);
  return agent;
}

async function waitForMedia(agent: request.Agent, id: number) {
  for (let i = 0; i < 100; i++) {
    const res = await agent.get(`/api/media/${id}`).expect(200);
    if (res.body.status !== "processing") return res.body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("media never finished processing");
}

const fixtures = path.join(os.tmpdir(), `linkmein-fixtures-${process.pid}`);
let png: Buffer;
let videoFile: string | null = null;

beforeAll(async () => {
  fs.mkdirSync(fixtures, { recursive: true });
  png = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#0a66c2" } }).png().toBuffer();
  try {
    videoFile = path.join(fixtures, "clip.mp4");
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10", "-pix_fmt", "yuv420p", videoFile]);
  } catch {
    videoFile = null; // ffmpeg not installed
  }
});

beforeEach(() => {
  freshDb();
});

describe("API", () => {
  it("requires a session and the CSRF header", async () => {
    await request(app).get("/api/me").expect(401);
    const agent = await login();
    await agent.get("/api/me").expect(200);
    await agent.put("/api/profile").send({ headline: "x" }).expect(403);
  });

  it("reports settings without leaking secrets", async () => {
    const agent = await login();
    const me = await agent.get("/api/me").expect(200);
    expect(me.body.settings).toMatchObject({ hasApiKey: false, apiKeyMasked: null, model: "claude-opus-5-5" });
    expect(JSON.stringify(me.body)).not.toContain("token");
  });

  it("saves and loads the profile", async () => {
    const agent = await login();
    const profile = { headline: "Product designer", audience: "Design leads", emoji: "none", writingSamples: "a\n---\nb" };
    await agent.put("/api/profile").set(H).send(profile).expect(200);
    const res = await agent.get("/api/profile").expect(200);
    expect(res.body).toEqual(profile);
    await agent.put("/api/profile").set(H).send({ emoji: "lots" }).expect(400);
  });

  it("asks for an API key before generating", async () => {
    const agent = await login();
    const res = await agent.post("/api/ai/generate").set(H).send({ notes: "We launched!" }).expect(400);
    expect(res.body.error).toMatch(/Anthropic API key/);
  });

  it("uploads and processes an image", async () => {
    const agent = await login();
    const res = await agent.post("/api/media").set(H).attach("files", png, { filename: "team.png", contentType: "image/png" }).expect(201);
    const media = await waitForMedia(agent, res.body[0].id);
    expect(media).toMatchObject({ kind: "image", status: "ready", width: 2400, height: 1600, hasPreview: true });
    const preview = await agent.get(`/api/media/${media.id}/preview`).expect(200);
    const meta = await sharp(preview.body as Buffer).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(1568);
  });

  it("rejects unsupported files", async () => {
    const agent = await login();
    await agent.post("/api/media").set(H).attach("files", Buffer.from("hi"), { filename: "a.txt", contentType: "text/plain" }).expect(400);
  });

  it("extracts frames from a video", async (ctx) => {
    if (!videoFile) ctx.skip();
    const agent = await login();
    const res = await agent.post("/api/media").set(H).attach("files", videoFile!, { contentType: "video/mp4" }).expect(201);
    const media = await waitForMedia(agent, res.body[0].id);
    expect(media).toMatchObject({ kind: "video", status: "ready", width: 320, height: 240, hasPreview: true });
    expect(media.durationS).toBeCloseTo(4, 0);
  });

  it("keeps users' data separate", async () => {
    const a = await login();
    const upload = await a.post("/api/media").set(H).attach("files", png, { filename: "a.png", contentType: "image/png" }).expect(201);
    const b = request.agent(app);
    // A second LinkedIn identity, created directly.
    const { upsertLinkedInUser } = await import("../server/users.js");
    const { createSession } = await import("../server/auth.js");
    const other = upsertLinkedInUser({ sub: "someone-else", name: "Other", email: null, picture: null }, null);
    const fakeRes = { cookie: (_n: string, value: string) => b.jar.setCookie(`lmi_session=${value}`) } as never;
    createSession(fakeRes, other.id);
    await b.get(`/api/media/${upload.body[0].id}`).expect(404);
    await b.get(`/api/media/${upload.body[0].id}/file`).expect(404);
  });

  it("creates, schedules, validates and publishes posts", async () => {
    setPublisher(async (p) => `urn:li:share:${p.id}`);
    const agent = await login();

    const draft = await agent.post("/api/posts").set(H).send({ text: "Draft", action: "draft" }).expect(201);
    expect(draft.body).toMatchObject({ status: "draft", scheduledAt: null });

    await agent.post("/api/posts").set(H).send({ text: "Old", action: "schedule", scheduledAt: Date.now() - 3_600_000 }).expect(400);
    await agent.post("/api/posts").set(H).send({ text: "x".repeat(3001), action: "draft" }).expect(400);

    const at = Date.now() + 3_600_000;
    const scheduled = await agent.put(`/api/posts/${draft.body.id}`).set(H).send({ text: "Scheduled", action: "schedule", scheduledAt: at }).expect(200);
    expect(scheduled.body).toMatchObject({ status: "scheduled", scheduledAt: at, text: "Scheduled" });

    await agent.post(`/api/posts/${draft.body.id}/publish`).set(H).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    const list = await agent.get("/api/posts").expect(200);
    expect(list.body[0]).toMatchObject({ status: "published", url: `https://www.linkedin.com/feed/update/urn:li:share:${draft.body.id}/` });

    await agent.put(`/api/posts/${draft.body.id}`).set(H).send({ text: "edit", action: "draft" }).expect(409);
  });

  it("refuses to attach audio or mix video with images", async (ctx) => {
    const agent = await login();
    const img = await agent.post("/api/media").set(H).attach("files", png, { filename: "a.png", contentType: "image/png" }).expect(201);
    if (videoFile) {
      const vid = await agent.post("/api/media").set(H).attach("files", videoFile, { contentType: "video/mp4" }).expect(201);
      const res = await agent.post("/api/posts").set(H).send({ text: "x", action: "draft", mediaIds: [img.body[0].id, vid.body[0].id] }).expect(400);
      expect(res.body.error).toMatch(/one video/);
    }
    const missing = await agent.post("/api/posts").set(H).send({ text: "x", action: "draft", mediaIds: [999] }).expect(400);
    expect(missing.body.error).toMatch(/not found/);
    if (!videoFile) ctx.skip();
  });
});
