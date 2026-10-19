import crypto from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { setPublisher } from "../server/posts.js";
import { run } from "../server/db.js";
import { freshDb } from "./helpers.js";

const app = createApp();
const H = { "X-Linkmein": "1" };
// A real 1x1 PNG.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function login() {
  const agent = request.agent(app);
  await agent.post("/auth/dev-login").set(H).expect(200);
  const me = await agent.get("/api/me").expect(200);
  return { agent, userId: me.body.user.id as number };
}

/** Mirrors the browser: PUT the bytes to storage, then register the media. */
async function uploadImage(agent: request.Agent, userId: number, extra: Record<string, unknown> = {}) {
  const dir = `u/${userId}/${crypto.randomUUID()}`;
  await agent.put(`/api/uploads/${dir}/original.png`).set(H).send(png).expect(201);
  await agent.put(`/api/uploads/${dir}/preview.jpg`).set(H).send(png).expect(201);
  const res = await agent
    .post("/api/media")
    .set(H)
    .send({ kind: "image", name: "team.png", mime: "image/png", fileKey: `${dir}/original.png`, previewKey: `${dir}/preview.jpg`, width: 1, height: 1, status: "ready", ...extra })
    .expect(201);
  return res.body;
}

beforeEach(async () => {
  await freshDb();
});

describe("API", () => {
  it("requires a session and the CSRF header", async () => {
    await request(app).get("/api/me").expect(401);
    const { agent } = await login();
    await agent.put("/api/profile").send({ headline: "x" }).expect(403);
  });

  it("reports settings without leaking secrets", async () => {
    const { agent } = await login();
    const me = await agent.get("/api/me").expect(200);
    expect(me.body.settings).toMatchObject({ hasApiKey: false, apiKeyMasked: null, model: "claude-opus-5-5" });
    expect(JSON.stringify(me.body)).not.toContain("token");
    const cfg = await agent.get("/api/config").expect(200);
    expect(cfg.body).toMatchObject({ storage: "local", maxUploadMb: 500 });
  });

  it("saves and loads the profile", async () => {
    const { agent } = await login();
    const profile = { headline: "Product designer", audience: "Design leads", emoji: "none", writingSamples: "a\n---\nb" };
    await agent.put("/api/profile").set(H).send(profile).expect(200);
    expect((await agent.get("/api/profile").expect(200)).body).toEqual(profile);
    await agent.put("/api/profile").set(H).send({ emoji: "lots" }).expect(400);
  });

  it("asks for an API key before generating", async () => {
    const { agent } = await login();
    const res = await agent.post("/api/ai/generate").set(H).send({ notes: "We launched!" }).expect(400);
    expect(res.body.error).toMatch(/Anthropic API key/);
  });

  it("stores uploads and serves them back", async () => {
    const { agent, userId } = await login();
    const media = await uploadImage(agent, userId);
    expect(media).toMatchObject({ kind: "image", status: "ready", size: png.length, hasPreview: true });
    const file = await agent.get(`/api/media/${media.id}/file`).expect(200);
    expect(Buffer.compare(file.body as Buffer, png)).toBe(0);
    await agent.get(`/api/media/${media.id}/preview`).expect(200);
    await agent.delete(`/api/media/${media.id}`).set(H).expect(200);
    await agent.get(`/api/media/${media.id}`).expect(404);
  });

  it("only accepts uploads into the user's own folder", async () => {
    const { agent, userId } = await login();
    const other = `u/${userId + 1}/${crypto.randomUUID()}/original.png`;
    await agent.put(`/api/uploads/${other}`).set(H).send(png).expect(403);
    await agent.put(`/api/uploads/u/${userId}/../../etc/passwd`).set(H).send(png).expect(403);
    await agent.post("/api/media").set(H).send({ kind: "image", name: "x", mime: "image/png", fileKey: other, status: "ready" }).expect(403);
  });

  it("rejects media that never arrived or has the wrong type", async () => {
    const { agent, userId } = await login();
    const missing = await agent
      .post("/api/media")
      .set(H)
      .send({ kind: "image", name: "x", mime: "image/png", fileKey: `u/${userId}/${crypto.randomUUID()}/original.png`, status: "ready" })
      .expect(400);
    expect(missing.body.error).toMatch(/didn't arrive/);
    const dir = `u/${userId}/${crypto.randomUUID()}`;
    await agent.put(`/api/uploads/${dir}/original.webp`).set(H).send(png).expect(201);
    await agent.post("/api/media").set(H).send({ kind: "image", name: "x", mime: "image/webp", fileKey: `${dir}/original.webp`, status: "ready" }).expect(400);
  });

  it("records transcripts finished later by the browser", async () => {
    const { agent, userId } = await login();
    const dir = `u/${userId}/${crypto.randomUUID()}`;
    await agent.put(`/api/uploads/${dir}/original.webm`).set(H).send(Buffer.from("audio")).expect(201);
    const m = await agent.post("/api/media").set(H).send({ kind: "audio", name: "note.webm", mime: "audio/webm", fileKey: `${dir}/original.webm`, status: "processing" }).expect(201);
    expect(m.body.status).toBe("processing");
    const done = await agent.patch(`/api/media/${m.body.id}`).set(H).send({ transcript: "hello world", status: "ready" }).expect(200);
    expect(done.body).toMatchObject({ status: "ready", transcript: "hello world" });
  });

  it("keeps users' data separate", async () => {
    const a = await login();
    const media = await uploadImage(a.agent, a.userId);
    const { upsertLinkedInUser } = await import("../server/users.js");
    const { createSession } = await import("../server/auth.js");
    const other = await upsertLinkedInUser({ sub: "someone-else", name: "Other", email: null, picture: null }, null);
    const b = request.agent(app);
    await createSession({ cookie: (_n: string, value: string) => b.jar.setCookie(`lmi_session=${value}`) } as never, other.id);
    await b.get(`/api/media/${media.id}`).expect(404);
    await b.get(`/api/media/${media.id}/file`).expect(404);
  });

  it("creates, schedules, validates and publishes posts", async () => {
    setPublisher(async (p) => `urn:li:share:${p.id}`);
    const { agent } = await login();

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

  it("refuses to attach audio, mix video with images, or use missing media", async () => {
    const { agent, userId } = await login();
    const img = await uploadImage(agent, userId);
    const dir = `u/${userId}/${crypto.randomUUID()}`;
    await agent.put(`/api/uploads/${dir}/original.mp4`).set(H).send(Buffer.from("video")).expect(201);
    const vid = await agent.post("/api/media").set(H).send({ kind: "video", name: "v.mp4", mime: "video/mp4", fileKey: `${dir}/original.mp4`, status: "ready" }).expect(201);
    const mixed = await agent.post("/api/posts").set(H).send({ text: "x", action: "draft", mediaIds: [img.id, vid.body.id] }).expect(400);
    expect(mixed.body.error).toMatch(/one video/);
    const missing = await agent.post("/api/posts").set(H).send({ text: "x", action: "draft", mediaIds: [999] }).expect(400);
    expect(missing.body.error).toMatch(/not found/);
  });

  it("publishes due posts when the cron endpoint is called with the secret", async () => {
    setPublisher(async (p) => `urn:li:share:${p.id}`);
    const { agent } = await login();
    const post = await agent.post("/api/posts").set(H).send({ text: "Due", action: "schedule", scheduledAt: Date.now() + 1000 }).expect(201);
    await run("UPDATE posts SET scheduled_at = ? WHERE id = ?", [Date.now() - 1000, post.body.id]);

    await request(app).get("/api/cron/publish").expect(401);
    await request(app).get("/api/cron/publish").set("Authorization", "Bearer wrong").expect(401);
    const res = await request(app).get("/api/cron/publish").set("Authorization", "Bearer test-cron-secret").expect(200);
    expect(res.body).toMatchObject({ ok: true, attempted: 1 });
    await request(app).get("/api/cron/publish?secret=test-cron-secret").expect(200);
    expect((await agent.get("/api/posts")).body[0].status).toBe("published");
  });
});
