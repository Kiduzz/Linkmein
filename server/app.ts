import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import { z, ZodError } from "zod";
import { config, linkedinConfigured } from "./config.js";
import { authRouter, loadSession, requireCsrfHeader, requireUser } from "./auth.js";
import { db, now, type InspirationRow, type UserRow } from "./db.js";
import { maskSecret } from "./crypto.js";
import { getAnthropicKey, getProfile, saveProfile, setAnthropicKey, updateUserSettings } from "./users.js";
import { AiError, verifyApiKey } from "./ai/claude.js";
import { analyzeInspiration, analyzeVoice, generatePosts, refinePost, remixPosts } from "./ai/generate.js";
import { splitSamples } from "./ai/prompts.js";
import {
  ACCEPTED_MIME,
  deleteMedia,
  getMedia,
  getMediaMany,
  insertMedia,
  kindFromMime,
  listMedia,
  processMedia,
  publicMedia,
  updateMediaDetails,
} from "./media/library.js";
import {
  claimPost,
  createPostRow,
  deletePostRow,
  getPost,
  HttpError,
  listPosts,
  publicPost,
  publishClaimed,
  updatePostRow,
} from "./posts.js";
import { MODELS, type Profile } from "../shared/types.js";

const user = (req: Request) => req.user as UserRow;
const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, "Invalid id");
  return id;
};

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

const MediaPatch = z.object({ transcript: z.string().max(50_000).optional(), altText: z.string().max(1_000).optional() });

// --- App ------------------------------------------------------------------------------

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(loadSession);
  app.use("/auth", requireCsrfHeader, authRouter);

  const api = express.Router();
  api.use(requireCsrfHeader);

  api.get("/config", (_req, res) => {
    res.json({ linkedinConfigured: linkedinConfigured(), devLogin: config.allowDevLogin, models: MODELS });
  });

  api.use(requireUser);

  api.get("/me", (req, res) => {
    const u = user(req);
    const key = getAnthropicKey(u);
    res.json({
      user: { id: u.id, name: u.name, email: u.email, picture: u.picture },
      settings: { hasApiKey: Boolean(key), apiKeyMasked: key ? maskSecret(key) : null, model: u.model ?? config.ai.defaultModel, timezone: u.timezone },
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
      setAnthropicKey(user(req).id, body.apiKey);
    }
    updateUserSettings(user(req).id, { model: body.model, timezone: body.timezone });
    res.json({ ok: true });
  });

  api.delete("/settings/api-key", (req, res) => {
    setAnthropicKey(user(req).id, null);
    res.json({ ok: true });
  });

  // Profile
  api.get("/profile", (req, res) => {
    res.json(getProfile(user(req).id));
  });

  api.put("/profile", (req, res) => {
    const profile = ProfileBody.parse(req.body) as Profile;
    saveProfile(user(req).id, profile);
    res.json(profile);
  });

  api.post("/profile/analyze-voice", async (req, res) => {
    const profile = getProfile(user(req).id);
    const voiceGuide = await analyzeVoice(user(req), splitSamples(profile.writingSamples));
    saveProfile(user(req).id, { ...profile, voiceGuide });
    res.json({ voiceGuide });
  });

  // Media
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const dir = path.join(config.uploadDir, String(user(req).id));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20 },
    fileFilter: (_req, file, cb) => {
      if (ACCEPTED_MIME.test(file.mimetype.split(";")[0])) cb(null, true);
      else cb(new HttpError(400, `Unsupported file type: ${file.mimetype}`));
    },
  });

  api.get("/media", (req, res) => {
    res.json(listMedia(user(req).id).map(publicMedia));
  });

  api.post("/media", upload.array("files", 20), (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw new HttpError(400, "No files uploaded");
    const rows = files.map((f) => {
      const mime = f.mimetype.split(";")[0];
      return insertMedia(user(req).id, { ...f, mimetype: mime }, kindFromMime(mime)!);
    });
    for (const row of rows) void processMedia(row);
    res.status(201).json(rows.map(publicMedia));
  });

  api.get("/media/:id", (req, res) => {
    const m = getMedia(user(req).id, idParam(req));
    if (!m) throw new HttpError(404, "Media not found");
    res.json(publicMedia(m));
  });

  api.patch("/media/:id", (req, res) => {
    const body = MediaPatch.parse(req.body);
    const id = idParam(req);
    updateMediaDetails(user(req).id, id, { transcript: body.transcript, alt_text: body.altText });
    res.json(publicMedia(getMedia(user(req).id, id)!));
  });

  api.delete("/media/:id", async (req, res) => {
    await deleteMedia(user(req).id, idParam(req));
    res.json({ ok: true });
  });

  api.get("/media/:id/file", (req, res) => {
    const m = getMedia(user(req).id, idParam(req));
    if (!m) throw new HttpError(404, "Media not found");
    res.type(m.mime).sendFile(m.path);
  });

  api.get("/media/:id/preview", (req, res) => {
    const m = getMedia(user(req).id, idParam(req));
    if (!m?.preview_path) throw new HttpError(404, "No preview");
    res.type("image/jpeg").sendFile(m.preview_path);
  });

  // AI
  api.post("/ai/generate", async (req, res) => {
    const body = GenerateBody.parse(req.body);
    const u = user(req);
    const media = getMediaMany(u.id, body.mediaIds);
    const { drafts, altTexts } = await generatePosts(u, getProfile(u.id), media, body);
    for (const { mediaId, altText } of altTexts) {
      const m = media.find((x) => x.id === mediaId);
      if (m && !m.alt_text && m.kind !== "audio") updateMediaDetails(u.id, m.id, { alt_text: altText.slice(0, 1_000) });
    }
    res.json({ drafts });
  });

  api.post("/ai/refine", async (req, res) => {
    const body = RefineBody.parse(req.body);
    const text = await refinePost(user(req), getProfile(user(req).id), body.text, body.instruction);
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
  const getInspiration = (userId: number, id: number) =>
    db().prepare("SELECT * FROM inspirations WHERE id = ? AND user_id = ?").get(id, userId) as InspirationRow | undefined;

  api.get("/inspirations", (req, res) => {
    const rows = db().prepare("SELECT * FROM inspirations WHERE user_id = ? ORDER BY created_at DESC").all(user(req).id) as InspirationRow[];
    res.json(rows.map(publicInspiration));
  });

  api.post("/inspirations", async (req, res) => {
    const body = InspirationBody.parse(req.body);
    const u = user(req);
    const screenshot = body.screenshotMediaId ? getMediaMany(u.id, [body.screenshotMediaId])[0] : undefined;
    if (screenshot && screenshot.kind !== "image") throw new HttpError(400, "The screenshot must be an image.");
    if (screenshot && screenshot.status !== "ready") throw new HttpError(409, "The screenshot is still processing.");
    const { text, analysis } = await analyzeInspiration(u, { text: body.text, screenshot });
    const result = db()
      .prepare(
        `INSERT INTO inspirations (user_id, source_text, source_author, source_url, image_media_id, analysis, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.id, text, body.author || null, body.url || null, screenshot?.id ?? null, JSON.stringify(analysis), now());
    res.status(201).json(publicInspiration(getInspiration(u.id, Number(result.lastInsertRowid))!));
  });

  api.delete("/inspirations/:id", (req, res) => {
    db().prepare("DELETE FROM inspirations WHERE id = ? AND user_id = ?").run(idParam(req), user(req).id);
    res.json({ ok: true });
  });

  api.post("/inspirations/:id/remix", async (req, res) => {
    const body = RemixBody.parse(req.body);
    const u = user(req);
    const inspiration = getInspiration(u.id, idParam(req));
    if (!inspiration) throw new HttpError(404, "Inspiration not found");
    const media = getMediaMany(u.id, body.mediaIds);
    const drafts = await remixPosts(u, getProfile(u.id), inspiration, media, { ...body, inspirationId: inspiration.id });
    res.json({ drafts });
  });

  // Posts and the schedule
  api.get("/posts", (req, res) => {
    res.json(listPosts(user(req).id).map(publicPost));
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
    db().prepare("UPDATE posts SET attempts = 0 WHERE id = ?").run(id);
    if (!claimPost(id, ["draft", "scheduled", "failed"])) throw new HttpError(409, "This post is already being published.");
    // Videos can take minutes to process on LinkedIn, so finish in the background.
    void publishClaimed(id);
  };

  api.post("/posts", async (req, res) => {
    const body = PostBody.parse(req.body);
    const { status, scheduledAt } = resolveStatus(body);
    const post = createPostRow(user(req).id, body, status, scheduledAt);
    if (body.action === "publish") await publishNow(post.id);
    res.status(201).json(publicPost(getPost(user(req).id, post.id)!));
  });

  api.put("/posts/:id", async (req, res) => {
    const body = PostBody.parse(req.body);
    const { status, scheduledAt } = resolveStatus(body);
    const id = idParam(req);
    updatePostRow(user(req).id, id, body, status, scheduledAt);
    if (body.action === "publish") await publishNow(id);
    res.json(publicPost(getPost(user(req).id, id)!));
  });

  api.post("/posts/:id/publish", async (req, res) => {
    const id = idParam(req);
    if (!getPost(user(req).id, id)) throw new HttpError(404, "Post not found");
    await publishNow(id);
    res.json(publicPost(getPost(user(req).id, id)!));
  });

  api.delete("/posts/:id", (req, res) => {
    deletePostRow(user(req).id, idParam(req));
    res.json({ ok: true });
  });

  app.use("/api", api);

  // The compiled server (dist/server) serves the built web app from dist/web. In dev, Vite serves it.
  const webDir = path.resolve(import.meta.dirname, "../web");
  if (import.meta.filename.endsWith(".js") && fs.existsSync(path.join(webDir, "index.html"))) {
    app.use(express.static(webDir, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/(api|auth)\/).*/, (_req, res) => res.sendFile(path.join(webDir, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    } else if (err instanceof HttpError || err instanceof AiError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof multer.MulterError) {
      res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? `Files are limited to ${config.maxUploadMb} MB.` : err.message });
    } else if (err instanceof Error && err.message.startsWith("Media not found")) {
      res.status(400).json({ error: err.message });
    } else {
      console.error(err);
      res.status(500).json({ error: "Something went wrong on the server." });
    }
  });

  return app;
}
