import crypto from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { setPublisher } from "../server/queue.js";
import { readSessionToken, sessionToken } from "../server/auth.js";
import { freshStorage } from "./helpers.js";

const app = createApp();
const H = { "X-Linkmein": "1" };

async function login() {
  const agent = request.agent(app);
  await agent.post("/auth/dev-login").set(H).expect(200);
  const me = await agent.get("/api/me").expect(200);
  return { agent, key: me.body.user.key as string };
}

const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 50 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 20));
};

beforeEach(async () => {
  await freshStorage();
  setPublisher(async (item) => `urn:li:share:${item.id}`);
});

describe("sessions", () => {
  it("signs sessions and rejects tampering or expiry", () => {
    const token = sessionToken("0123456789abcdef01234567");
    expect(readSessionToken(token)).toBe("0123456789abcdef01234567");
    const [data, mac] = token.split(".");
    expect(readSessionToken(`${data}x.${mac}`)).toBeNull();
    expect(readSessionToken(sessionToken("0123456789abcdef01234567", Date.now() - 1))).toBeNull();
  });
});

describe("API", () => {
  it("sends a share that missed the service worker to Remix", async () => {
    const res = await request(app).post("/share-target").attach("screenshots", Buffer.from("x"), "a.png").expect(303);
    expect(res.headers.location).toBe("/remix?shared=failed");
  });

  it("requires a session and the CSRF header", async () => {
    await request(app).get("/api/me").expect(401);
    const { agent } = await login();
    await agent.post("/api/queue").send({ id: crypto.randomUUID(), text: "x" }).expect(403);
  });

  it("reports the account without leaking tokens", async () => {
    const { agent, key } = await login();
    const me = await agent.get("/api/me").expect(200);
    expect(me.body).toMatchObject({ user: { key, name: "Dev User" }, linkedin: { connected: false } });
    expect(JSON.stringify(me.body)).not.toMatch(/token/i);
    expect((await agent.get("/api/config").expect(200)).body).toMatchObject({ storage: "local", maxUploadMb: 500 });
  });

  it("accepts uploads only into the account's folder", async () => {
    const { agent, key } = await login();
    await agent.put(`/api/uploads/u/${key}/${crypto.randomUUID()}/0.jpg`).set(H).send(Buffer.from("jpeg")).expect(201);
    await agent.put(`/api/uploads/u/ffffffffffffffffffffffff/${crypto.randomUUID()}/0.jpg`).set(H).send(Buffer.from("x")).expect(403);
    await agent.put(`/api/uploads/queue/index.json`).set(H).send(Buffer.from("{}")).expect(403);
  });

  it("schedules a post, reports its status, and lets the phone take it back", async () => {
    const { agent, key } = await login();
    const id = crypto.randomUUID();
    const mediaKey = `u/${key}/${id}/0.jpg`;
    await agent.put(`/api/uploads/${mediaKey}`).set(H).send(Buffer.from("jpeg")).expect(201);
    const dueAt = Date.now() + 3_600_000;
    const queued = await agent.post("/api/queue").set(H).send({ id, text: "Later", dueAt, media: [{ key: mediaKey, kind: "image", mime: "image/jpeg" }] }).expect(201);
    expect(queued.body).toMatchObject({ id, status: "scheduled", dueAt });

    await agent.post("/api/queue").set(H).send({ id: crypto.randomUUID(), text: "Old", dueAt: Date.now() - 3_600_000 }).expect(400);
    const status = await agent.get(`/api/queue?ids=${id},missing-id-123`).expect(200);
    expect(status.body[id]).toMatchObject({ status: "scheduled" });
    expect(status.body["missing-id-123"]).toBeNull();

    await agent.delete(`/api/queue/${id}`).set(H).expect(200);
    expect((await agent.get(`/api/queue?ids=${id}`)).body[id]).toBeNull();
  });

  it("publishes right away when no time is given", async () => {
    const { agent } = await login();
    const id = crypto.randomUUID();
    const res = await agent.post("/api/queue").set(H).send({ id, text: "Now" }).expect(201);
    expect(res.body.status).toBe("publishing");
    let body: Record<string, { status: string; url: string }> = {};
    await until(async () => {
      body = (await agent.get(`/api/queue?ids=${id}`)).body;
      return body[id]?.status === "published";
    });
    expect(body[id]).toMatchObject({ status: "published", url: `https://www.linkedin.com/feed/update/urn:li:share:${id}/` });
  });

  it("keeps other accounts out of a post", async () => {
    const { agent } = await login();
    const id = crypto.randomUUID();
    await agent.post("/api/queue").set(H).send({ id, text: "Mine", dueAt: Date.now() + 60_000 }).expect(201);
    const other = request.agent(app);
    other.jar.setCookie(`lmi_session=${sessionToken("ffffffffffffffffffffffff")}`);
    expect((await other.get(`/api/queue?ids=${id}`).expect(200)).body[id]).toBeNull();
    await other.delete(`/api/queue/${id}`).set(H).expect(200);
    expect((await agent.get(`/api/queue?ids=${id}`)).body[id]).toMatchObject({ status: "scheduled" });
  });

  it("publishes due posts when the cron endpoint is called with the secret", async () => {
    const { agent } = await login();
    const id = crypto.randomUUID();
    await agent.post("/api/queue").set(H).send({ id, text: "Due", dueAt: Date.now() }).expect(201);
    await request(app).get("/api/cron/publish").expect(401);
    await request(app).get("/api/cron/publish").set("Authorization", "Bearer wrong").expect(401);
    const res = await request(app).get("/api/cron/publish").set("Authorization", "Bearer test-cron-secret").expect(200);
    expect(res.body).toMatchObject({ ok: true, attempted: 1 });
    await request(app).get("/api/cron/publish?secret=test-cron-secret").expect(200);
    expect((await agent.get(`/api/queue?ids=${id}`)).body[id].status).toBe("published");
  });
});
