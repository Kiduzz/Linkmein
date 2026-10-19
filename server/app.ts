import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { z, ZodError } from "zod";
import { config, linkedinConfigured } from "./config.js";
import { authRouter, loadSession, requireCsrfHeader, requireUser } from "./auth.js";
import { getAccount } from "./accounts.js";
import { ownsKey, TooLargeError, writeLocal } from "./storage.js";
import { claim, enqueue, getItem, publicItem, publishClaimed, QueueError, removeItem, retryItem, runDue } from "./queue.js";

// The server's whole job: sign in with LinkedIn, accept scheduled posts, and
// publish them on time. Profiles, drafts, media and AI calls stay on the phone.

const account = (req: Request) => req.accountKey as string;

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

const QueueBody = z.object({
  id: z.string().min(8).max(64),
  text: z.string().max(3_000),
  visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
  /** Omit to publish right away. */
  dueAt: z.number().int().optional(),
  media: z
    .array(z.object({ key: z.string().max(200), kind: z.enum(["image", "video"]), mime: z.string().max(100), altText: z.string().max(1_000).optional() }))
    .max(20)
    .default([]),
});

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  // The publish run called by Vercel Cron or an external cron service. Defined
  // before the cookie/CSRF middleware: it authenticates with CRON_SECRET instead.
  app.all("/api/cron/publish", async (req, res) => {
    if (!config.cronSecret) {
      res.status(503).json({ error: "Set CRON_SECRET to enable the publish endpoint." });
      return;
    }
    const supplied = Buffer.from(req.get("authorization")?.replace(/^Bearer\s+/i, "") ?? String(req.query.secret ?? ""));
    const expected = Buffer.from(config.cronSecret);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      res.status(401).json({ error: "Bad cron secret" });
      return;
    }
    // Leave a minute of the 5-minute function limit for the post in progress to finish.
    res.json({ ok: true, ...(await runDue(Date.now(), 4 * 60_000)) });
  });

  // Android's share sheet posts here. The service worker normally answers it on the phone;
  // this only runs if it isn't installed yet, so send the person to Remix to pick the files instead.
  app.post("/share-target", (_req, res) => res.redirect(303, "/remix?shared=failed"));

  // Local storage: the browser PUTs file bytes here. Mounted before express.json so the body stays a stream.
  app.put("/api/uploads/{*key}", cookieParser(), loadSession, requireCsrfHeader, requireUser, async (req, res) => {
    if (config.storage !== "local") throw new QueueError(404, "Uploads go to Vercel Blob on this server.");
    const k = (req.params as { key: string[] }).key.join("/");
    if (!ownsKey(account(req), k)) throw new QueueError(403, "Invalid upload key.");
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
    res.json({ linkedinConfigured: linkedinConfigured(), devLogin: config.allowDevLogin, storage: config.storage, maxUploadMb: config.maxUploadMb });
  });

  api.use(requireUser);

  api.get("/me", async (req, res) => {
    const a = await getAccount(account(req));
    if (!a) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    res.json({
      user: { key: a.key, name: a.name, email: a.email, picture: a.picture },
      linkedin: { connected: Boolean(a.tokenEnc), expiresAt: a.expiresAt, dryRun: config.linkedin.dryRun },
    });
  });

  // Media for scheduled posts goes straight from the phone to Blob storage.
  api.post("/blob/upload", async (req, res) => {
    if (config.storage !== "blob") throw new QueueError(404, "Vercel Blob isn't configured on this server.");
    const key = account(req);
    const result = await handleUpload({
      request: req,
      body: req.body as HandleUploadBody,
      onBeforeGenerateToken: async (pathname) => {
        if (!ownsKey(key, pathname)) throw new QueueError(403, "Invalid upload key.");
        return {
          addRandomSuffix: false,
          allowOverwrite: false,
          maximumSizeInBytes: config.maxUploadMb * 1024 * 1024,
          allowedContentTypes: ["image/jpeg", "image/png", "image/gif", "video/*"],
        };
      },
    });
    res.json(result);
  });

  // The publish queue
  api.post("/queue", async (req, res) => {
    const body = QueueBody.parse(req.body);
    const now = Date.now();
    if (body.dueAt !== undefined && body.dueAt < now - 60_000) throw new QueueError(400, "That time is in the past.");
    const item = await enqueue(account(req), { ...body, dueAt: body.dueAt ?? now });
    if (body.dueAt === undefined) {
      const claimed = await claim(item.id, now);
      if (claimed) {
        // Videos can take minutes to process on LinkedIn, so finish after replying.
        await background(publishClaimed(claimed));
        res.status(201).json(publicItem(claimed));
        return;
      }
    }
    res.status(201).json(publicItem(item));
  });

  /** Status of the given queued posts. Cached reads: up to a minute stale, and free on Blob's quota. */
  api.get("/queue", async (req, res) => {
    const ids = String(req.query.ids ?? "")
      .split(",")
      .filter(Boolean)
      .slice(0, 50);
    const items = await Promise.all(ids.map((id) => getItem(account(req), id)));
    res.json(Object.fromEntries(ids.map((id, i) => [id, items[i] ? publicItem(items[i]) : null])));
  });

  api.delete("/queue/:id", async (req, res) => {
    await removeItem(account(req), String(req.params.id));
    res.json({ ok: true });
  });

  api.post("/queue/:id/retry", async (req, res) => {
    const item = await retryItem(account(req), String(req.params.id));
    const claimed = await claim(item.id);
    if (claimed) await background(publishClaimed(claimed));
    res.json(publicItem(claimed ?? item));
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
    } else if (err instanceof QueueError) {
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
