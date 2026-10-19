import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { z, ZodError } from "zod";
import { config, linkedinConfigured } from "./config.js";
import { authRouter, loadSession, requireCsrfHeader, requireUser } from "./auth.js";
import { all, dbReady, get, now, run, type InspirationRow, type UserRow } from "./db.js";
import { maskSecret } from "./crypto.js";
import { getAnthropicKey, getProfile, saveProfile, setAnthropicKey, updateUserSettings } from "./users.js";
import { AiError, verifyApiKey } from "./ai/claude.js";
import { analyzeInspiration, analyzeVoice, generatePosts, refinePost, remixPosts } from "./ai/generate.js";
import { splitSamples } from "./ai/prompts.js";
import { deleteMedia, getMedia, getMediaMany, listMedia, MediaError, publicMedia, registerMedia, updateMediaDetails } from "./media/library.js";
import { locate, ownsKey, TooLargeError, writeLocal } from "./storage.js";
import { claimPost, createPostRow, deletePostRow, getPost, HttpError, listPosts, publicPost, publishClaimed, updatePostRow } from "./posts.js";
import { recoverInterrupted, runDuePosts } from "./scheduler.js";
import { MODELS, type Profile } from "../shared/types.js";

const user = (req: Request) => req.user as UserRow;
const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, "Invalid id");
  return id;
};

/**
 * Keeps work going after the response is sent. On Vercel the function would
 * otherwise freeze as soon as we reply; waitUntil keeps it alive until done.
 */
async function background(work: Promise<unknown>): Promise<void> {
  const task = work.catch((err) => console.error("Background task failed", err));
  if (config.onVercel) {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(task);
  } else {
    void task;
  }
}

// --- Request schemas ------------------------------------------------------------

const SettingsBody = z.object({
  apiKey: z.string().trim().min(1).optional(),
  model: z.enum(MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
  timezone: z.string().max(64).optional(),
});

const optionalText = z.string().max(20_000).optional();
const ProfileBody = z.object({
  headline: optionalText,
  about: optionalText,
  industry: optionalText,
  audience: optionalText,
  goals: optionalText,
  topics: optionalText,
  experiences: optionalText,
  tone: optionalText,
  avoid: optionalText,
  callToAction: optionalText,
  emoji: z.enum(["none", "light", "expressive"]).optional(),
  hashtags: z.enum(["none", "few", "several"]).optional(),
  language: optionalText,
  writingSamples: z.string().max(60_000).optional(),
  voiceGuide: optionalText,
});

const lengthEnum = z.enum(["short", "medium", "long"]).optional();
const GenerateBody = z.object({
  mediaIds: z.array(z.number().int()).max(20).default([]),
  notes: z.string().max(10_000).default(""),
  goal: z.string().max(200).optional(),
  tone: z.string().max(200).optional(),
  length: lengthEnum,
  variations: z.number().int().min(1).max(4).optional(),
});

const RefineBody = z.object({ text: z.string().max(5_000), instruction: z.string().max(1_000).default("") });

const InspirationBody = z.object({
  text: z.string().max(10_000).default(""),
  author: z.string().max(200).optional(),
  url: z.string().max(2_000).optional(),
  screenshotMediaId: z.number().int().optional(),
});

const RemixBody = z.object({
  notes: z.string().max(10_000).default(""),
  mediaIds: z.array(z.number().int()).max(20).default([]),
  variations: z.number().int().min(1).max(4).optional(),
  length: lengthEnum,
});

const PostBody = z.object({
  text: z.string().max(3_000),
  mediaIds: z.array(z.number().int()).max(20).default([]),
  visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
  action: z.enum(["draft", "schedule", "publish"]),
  scheduledAt: z.number().int().optional(),
  source: z.string().max(50).optional(),
  inspirationId: z.number().int().optional(),
});

const key = z.string().max(200);
const MediaBody = z.object({
  kind: z.enum(["image", "audio", "video"]),
  name: z.string().min(1).max(200),
  mime: z.string().max(100),
  fileKey: key,
  previewKey: key.optional(),
  frameKeys: z.array(key).max(8).optional(),
  durationS: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  transcript: z.string().max(50_000).optional(),
  status: z.enum(["processing", "ready"]),
  error: z.string().max(500).optional(),
});

const MediaPatch = z.object({
  transcript: z.string().max(50_000).optional(),
  altText: z.string().max(1_000).optional(),
  status: z.enum(["ready", "failed"]).optional(),
  error: z.string().max(500).nullable().optional(),
});

// --- App ------------------------------------------------------------------------------

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(async (_req, _res, next) => {
    await dbReady();
    next();
  });

  // The publish run called by Vercel Cron or an external cron service. Defined
  // before the cookie/CSRF middleware: it authenticates with CRON_SECRET instead.
  app.all("/api/cron/publish", async (req, res) => {
    const supplied = req.get("authorization")?.replace(/^Bearer\s+/i, "") ?? String(req.query.secret ?? "");
    if (!config.cronSecret) {
      res.status(503).json({ error: "Set CRON_SECRET to enable the publish endpoint." });
      return;
    }
    const a = Buffer.from(supplied);
    const b = Buffer.from(config.cronSecret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ error: "Bad cron secret" });
      return;
    }
    const recovered = await recoverInterrupted();
    // Leave a minute of the 5-minute function limit for the post in progress to finish.
    const published = await runDuePosts(now(), 4 * 60_000);
    res.json({ ok: true, attempted: published, recovered });
  });

  // Local storage: the browser PUTs file bytes here. Mounted before express.json so the body stays a stream.
  app.put("/api/uploads/{*key}", cookieParser(), loadSession, requireCsrfHeader, requireUser, async (req, res) => {
    if (config.storage !== "local") throw new HttpError(404, "Uploads go to Vercel Blob on this server.");
    const k = (req.params as { key: string[] }).key.join("/");
    if (!ownsKey(user(req).id, k)) throw new HttpError(403, "Invalid upload key.");
    const size = await writeLocal(k, req, config.maxUploadMb * 1024 * 1024);
    res.status(201).json({ key: k, size });
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(loadSession);
  app.use("/auth", requireCsrfHeader, authRouter);

  const api = express.Router();
  api.use(requireCsrfHeader);

  api.get("/config", (_req, res) => {
    res.json({
      linkedinConfigured: linkedinConfigured(),
      devLogin: config.allowDevLogin,
      models: MODELS,
      storage: config.storage,
      maxUploadMb: config.maxUploadMb,
    });
  });

  api.use(requireUser);

  api.get("/me", (req, res) => {
    const u = user(req);
    const apiKey = getAnthropicKey(u);
    res.json({
      user: { id: u.id, name: u.name, email: u.email, picture: u.picture },
      settings: { hasApiKey: Boolean(apiKey), apiKeyMasked: apiKey ? maskSecret(apiKey) : null, model: u.model ?? config.ai.defaultModel, timezone: u.timezone },
      linkedin: {
        connected: Boolean(u.linkedin_token_enc),
        expiresAt: u.linkedin_token_expires_at,
        dryRun: config.linkedin.dryRun,
      },
    });
  });

  api.put("/settings", async (req, res) => {
    const body = SettingsBody.parse(req.body);
    if (body.apiKey) {
      await verifyApiKey(body.apiKey);
      await setAnthropicKey(user(req).id, body.apiKey);
    }
    await updateUserSettings(user(req).id, { model: body.model, timezone: body.timezone });
    res.json({ ok: true });
  });

  api.delete("/settings/api-key", async (req, res) => {
    await setAnthropicKey(user(req).id, null);
    res.json({ ok: true });
  });

  // Profile
  api.get("/profile", async (req, res) => {
    res.json(await getProfile(user(req).id));
  });

  api.put("/profile", async (req, res) => {
    const profile = ProfileBody.parse(req.body) as Profile;
    await saveProfile(user(req).id, profile);
    res.json(profile);
  });

  api.post("/profile/analyze-voice", async (req, res) => {
    const profile = await getProfile(user(req).id);
    const voiceGuide = await analyzeVoice(user(req), splitSamples(profile.writingSamples));
    await saveProfile(user(req).id, { ...profile, voiceGuide });
    res.json({ voiceGuide });
  });

  // Media. Files go straight from the browser to storage; then the browser registers them here.
  api.post("/blob/upload", async (req, res) => {
    if (config.storage !== "blob") throw new HttpError(404, "Vercel Blob isn't configured on this server.");
    const userId = user(req).id;
    const result = await handleUpload({
      request: req,
      body: req.body as HandleUploadBody,
      onBeforeGenerateToken: async (pathname) => {
        if (!ownsKey(userId, pathname)) throw new HttpError(403, "Invalid upload key.");
        return {
          addRandomSuffix: false,
          allowOverwrite: false,
          maximumSizeInBytes: config.maxUploadMb * 1024 * 1024,
          allowedContentTypes: ["image/jpeg", "image/png", "image/gif", "audio/*", "video/*"],
        };
      },
    });
    res.json(result);
  });

  api.get("/media", async (req, res) => {
    res.json((await listMedia(user(req).id)).map(publicMedia));
  });

  api.post("/media", async (req, res) => {
    const body = MediaBody.parse(req.body);
    const m = await registerMedia(user(req).id, body);
    res.status(201).json(publicMedia(m));
  });

  api.get("/media/:id", async (req, res) => {
    const m = await getMedia(user(req).id, idParam(req));
    if (!m) throw new HttpError(404, "Media not found");
    res.json(publicMedia(m));
  });

  api.patch("/media/:id", async (req, res) => {
    const body = MediaPatch.parse(req.body);
    const id = idParam(req);
    await updateMediaDetails(user(req).id, id, { transcript: body.transcript, alt_text: body.altText, status: body.status, error: body.error });
    res.json(publicMedia((await getMedia(user(req).id, id))!));
  });

  api.delete("/media/:id", async (req, res) => {
    await deleteMedia(user(req).id, idParam(req));
    res.json({ ok: true });
  });

  const sendStored = async (res: Response, storageKey: string, mime: string) => {
    const where = await locate(storageKey);
    if ("file" in where) {
      res.type(mime).sendFile(where.file);
    } else {
      // Signed URLs last an hour; let the browser reuse the redirect for a while.
      res.set("Cache-Control", "private, max-age=1800").redirect(302, where.url);
    }
  };

  api.get("/media/:id/file", async (req, res) => {
    const m = await getMedia(user(req).id, idParam(req));
    if (!m) throw new HttpError(404, "Media not found");
    await sendStored(res, m.file_key, m.mime);
  });

  api.get("/media/:id/preview", async (req, res) => {
    const m = await getMedia(user(req).id, idParam(req));
    if (!m?.preview_key) throw new HttpError(404, "No preview");
    await sendStored(res, m.preview_key, "image/jpeg");
  });

  // AI
  api.post("/ai/generate", async (req, res) => {
    const body = GenerateBody.parse(req.body);
    const u = user(req);
    const media = await getMediaMany(u.id, body.mediaIds);
    const { drafts, altTexts } = await generatePosts(u, await getProfile(u.id), media, body);
    for (const { mediaId, altText } of altTexts) {
      const m = media.find((x) => x.id === mediaId);
      if (m && !m.alt_text && m.kind !== "audio") await updateMediaDetails(u.id, m.id, { alt_text: altText.slice(0, 1_000) });
    }
    res.json({ drafts });
  });

  api.post("/ai/refine", async (req, res) => {
    const body = RefineBody.parse(req.body);
    const text = await refinePost(user(req), await getProfile(user(req).id), body.text, body.instruction);
    res.json({ text });
  });

  // Inspiration: other people's posts to learn from
  const publicInspiration = (i: InspirationRow) => ({
    id: i.id,
    text: i.source_text,
    author: i.source_author,
    url: i.source_url,
    screenshotMediaId: i.image_media_id,
    analysis: i.analysis ? JSON.parse(i.analysis) : null,
    createdAt: i.created_at,
  });
  const getInspiration = (userId: number, id: number) => get<InspirationRow>("SELECT * FROM inspirations WHERE id = ? AND user_id = ?", [id, userId]);

  api.get("/inspirations", async (req, res) => {
    const rows = await all<InspirationRow>("SELECT * FROM inspirations WHERE user_id = ? ORDER BY created_at DESC", [user(req).id]);
    res.json(rows.map(publicInspiration));
  });

  api.post("/inspirations", async (req, res) => {
    const body = InspirationBody.parse(req.body);
    const u = user(req);
    const screenshot = body.screenshotMediaId ? (await getMediaMany(u.id, [body.screenshotMediaId]))[0] : undefined;
    if (screenshot && screenshot.kind !== "image") throw new HttpError(400, "The screenshot must be an image.");
    const { text, analysis } = await analyzeInspiration(u, { text: body.text, screenshot });
    const result = await run(
      `INSERT INTO inspirations (user_id, source_text, source_author, source_url, image_media_id, analysis, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [u.id, text, body.author || null, body.url || null, screenshot?.id ?? null, JSON.stringify(analysis), now()],
    );
    res.status(201).json(publicInspiration((await getInspiration(u.id, result.lastId))!));
  });

  api.delete("/inspirations/:id", async (req, res) => {
    await run("DELETE FROM inspirations WHERE id = ? AND user_id = ?", [idParam(req), user(req).id]);
    res.json({ ok: true });
  });

  api.post("/inspirations/:id/remix", async (req, res) => {
    const body = RemixBody.parse(req.body);
    const u = user(req);
    const inspiration = await getInspiration(u.id, idParam(req));
    if (!inspiration) throw new HttpError(404, "Inspiration not found");
    const media = await getMediaMany(u.id, body.mediaIds);
    const drafts = await remixPosts(u, await getProfile(u.id), inspiration, media, { ...body, inspirationId: inspiration.id });
    res.json({ drafts });
  });

  // Posts and the schedule
  api.get("/posts", async (req, res) => {
    res.json((await listPosts(user(req).id)).map(publicPost));
  });

  const resolveStatus = (body: z.infer<typeof PostBody>) => {
    if (body.action === "schedule") {
      if (!body.scheduledAt) throw new HttpError(400, "Pick a time to schedule the post.");
      if (body.scheduledAt < now() - 60_000) throw new HttpError(400, "That time is in the past.");
      return { status: "scheduled" as const, scheduledAt: body.scheduledAt };
    }
    return { status: "draft" as const, scheduledAt: null };
  };

  const publishNow = async (id: number) => {
    await run("UPDATE posts SET attempts = 0 WHERE id = ? AND status IN ('draft', 'scheduled', 'failed')", [id]);
    if (!(await claimPost(id, ["draft", "scheduled", "failed"]))) throw new HttpError(409, "This post is already being published.");
    // Videos can take minutes to process on LinkedIn, so finish after replying.
    await background(publishClaimed(id));
  };

  api.post("/posts", async (req, res) => {
    const body = PostBody.parse(req.body);
    const { status, scheduledAt } = resolveStatus(body);
    const post = await createPostRow(user(req).id, body, status, scheduledAt);
    if (body.action === "publish") await publishNow(post.id);
    res.status(201).json(publicPost((await getPost(user(req).id, post.id))!));
  });

  api.put("/posts/:id", async (req, res) => {
    const body = PostBody.parse(req.body);
    const { status, scheduledAt } = resolveStatus(body);
    const id = idParam(req);
    await updatePostRow(user(req).id, id, body, status, scheduledAt);
    if (body.action === "publish") await publishNow(id);
    res.json(publicPost((await getPost(user(req).id, id))!));
  });

  api.post("/posts/:id/publish", async (req, res) => {
    const id = idParam(req);
    if (!(await getPost(user(req).id, id))) throw new HttpError(404, "Post not found");
    await publishNow(id);
    res.json(publicPost((await getPost(user(req).id, id))!));
  });

  api.delete("/posts/:id", async (req, res) => {
    await deletePostRow(user(req).id, idParam(req));
    res.json({ ok: true });
  });

  app.use("/api", api);

  // The compiled self-hosted server (dist/server) serves the built web app from dist/web.
  // In dev Vite serves it, and on Vercel the CDN does.
  const webDir = path.resolve(import.meta.dirname, "../web");
  if (!config.onVercel && import.meta.filename.endsWith(".js") && fs.existsSync(path.join(webDir, "index.html"))) {
    app.use(express.static(webDir, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/(api|auth)\/).*/, (_req, res) => res.sendFile(path.join(webDir, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    } else if (err instanceof HttpError || err instanceof AiError || err instanceof MediaError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof TooLargeError) {
      res.status(413).json({ error: err.message });
    } else {
      console.error(err);
      res.status(500).json({ error: "Something went wrong on the server." });
    }
  });

  return app;
}
