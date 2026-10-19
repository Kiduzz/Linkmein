import type { GenerateOptions, InspirationAnalysis, PostDraft, Profile, RemixDraft } from "../../shared/types";
import { MODELS } from "../../shared/types";
import { splitSamples } from "../../shared/ai/prompts";
import { addRecord, db, openAccount, type LocalSettings, type StoredMedia, type StoredPost } from "./local/db";
import { extension, uploadToServer } from "./local/upload";
import { verifyApiKey, type AiContext } from "./ai/claude";
import { analyzeInspiration, analyzeVoice, checkHook, generatePosts, refinePost, remixPosts, type HookReview } from "./ai/generate";

// The app's data layer. Profile, Claude key, media, saved posts and drafts live on
// this device (see local/db.ts). The server is only used to sign in with LinkedIn
// and to hand over posts for publishing at their scheduled time.

export interface Me {
  user: { key: string; name: string; email: string | null; picture: string | null };
  settings: { hasApiKey: boolean; apiKeyMasked: string | null; model: string };
  linkedin: { connected: boolean; expiresAt: number | null; dryRun: boolean };
}

export interface AppConfig {
  linkedinConfigured: boolean;
  devLogin: boolean;
  models: { id: string; label: string }[];
  storage: "local" | "blob";
  maxUploadMb: number;
}

export interface Media {
  id: number;
  kind: "image" | "audio" | "video";
  name: string;
  mime: string;
  size: number;
  /** "processing" while speech is still being transcribed on this device. */
  status: "processing" | "ready" | "failed";
  error: string | null;
  transcript: string | null;
  altText: string | null;
  durationS: number | null;
  width: number | null;
  height: number | null;
  hasPreview: boolean;
  createdAt: number;
}

export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed";

export interface Post {
  id: number;
  text: string;
  mediaIds: number[];
  status: PostStatus;
  scheduledAt: number | null;
  publishedAt: number | null;
  url: string | null;
  attempts: number;
  lastError: string | null;
  visibility: "PUBLIC" | "CONNECTIONS";
  source: string | null;
  inspirationId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Inspiration {
  id: number;
  text: string;
  author: string | null;
  url: string | null;
  screenshotMediaId: number | null;
  analysis: InspirationAnalysis | null;
  createdAt: number;
}

export interface SavePostInput {
  text: string;
  mediaIds: number[];
  visibility: "PUBLIC" | "CONNECTIONS";
  action: "draft" | "schedule" | "publish";
  scheduledAt?: number;
  source?: string;
  inspirationId?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "X-Linkmein": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

// --- Local helpers -----------------------------------------------------------------

const DEFAULT_SETTINGS: LocalSettings = { apiKey: null, model: MODELS[0].id };

async function getSettings(): Promise<LocalSettings> {
  return { ...DEFAULT_SETTINGS, ...((await (await db()).get("kv", "settings")) as Partial<LocalSettings> | undefined) };
}

async function setSettings(patch: Partial<LocalSettings>): Promise<void> {
  await (await db()).put("kv", { ...(await getSettings()), ...patch }, "settings");
}

async function getProfile(): Promise<Profile> {
  return ((await (await db()).get("kv", "profile")) as Profile | undefined) ?? {};
}

let me: Me | null = null;
let serverConfig: AppConfig | null = null;

async function aiContext(): Promise<AiContext> {
  const s = await getSettings();
  return { name: me?.user.name ?? "the author", apiKey: s.apiKey, model: s.model };
}

const mask = (k: string) => (k.length <= 12 ? "••••" : `${k.slice(0, 7)}…${k.slice(-4)}`);

// Object URLs for showing stored files, created once per blob.
const urls = new Map<number, { file?: string; preview?: string }>();
function remember(m: StoredMedia): void {
  const existing = urls.get(m.id);
  if (existing) return;
  urls.set(m.id, { file: URL.createObjectURL(m.blob), preview: m.preview ? URL.createObjectURL(m.preview) : undefined });
}
function forget(id: number): void {
  const u = urls.get(id);
  if (u?.file) URL.revokeObjectURL(u.file);
  if (u?.preview) URL.revokeObjectURL(u.preview);
  urls.delete(id);
}

/** Media without its file contents, as the UI uses it. */
function publicMedia(m: StoredMedia): Media {
  remember(m);
  const { blob: _b, preview, frames: _f, ...rest } = m;
  return { ...rest, hasPreview: Boolean(preview) };
}

async function storedMedia(ids: number[]): Promise<StoredMedia[]> {
  const d = await db();
  const rows = await Promise.all(ids.map((id) => d.get("media", id)));
  const missing = ids.filter((_, i) => !rows[i]);
  if (missing.length) throw new ApiError(`Media not found: ${missing.join(", ")}`, 404);
  return rows as StoredMedia[];
}

function publicPost(p: StoredPost): Post {
  const { queueId: _q, ...rest } = p;
  return rest;
}

// --- Publishing through the server's queue ------------------------------------------

interface QueueStatus {
  id: string;
  status: "scheduled" | "publishing" | "published" | "failed";
  dueAt: number;
  attempts: number;
  lastError: string | null;
  publishedAt: number | null;
  url: string | null;
}

/** Hands a post and its files to the server, which publishes it at `dueAt` (or now). */
async function handOver(post: StoredPost, dueAt: number | null): Promise<QueueStatus> {
  if (!me || !serverConfig) throw new ApiError("Not signed in", 401);
  const queueId = crypto.randomUUID();
  const media = await storedMedia(post.mediaIds);
  if (media.some((m) => m.kind === "audio")) throw new ApiError("Audio can't be attached to a LinkedIn post. It's only used to write the text.", 400);
  const tooBig = media.find((m) => m.blob.size > serverConfig!.maxUploadMb * 1024 * 1024);
  if (tooBig) throw new ApiError(`"${tooBig.name}" is over the ${serverConfig.maxUploadMb} MB limit for posting.`, 400);
  const uploads = await Promise.all(
    media.map(async (m, i) => {
      const key = `u/${me!.user.key}/${queueId}/${i}.${extension(m.blob, m.kind === "video" ? "mp4" : "jpg")}`;
      await uploadToServer(serverConfig!, key, m.blob);
      return { key, kind: m.kind as "image" | "video", mime: m.blob.type || m.mime, altText: m.altText ?? undefined };
    }),
  );
  return call<QueueStatus>("POST", "/api/queue", {
    id: queueId,
    text: post.text,
    visibility: post.visibility,
    ...(dueAt ? { dueAt } : {}),
    media: uploads,
  });
}

function applyQueueStatus(post: StoredPost, q: QueueStatus): StoredPost {
  return {
    ...post,
    queueId: q.id,
    status: q.status,
    scheduledAt: q.dueAt,
    attempts: q.attempts,
    lastError: q.lastError,
    publishedAt: q.publishedAt,
    url: q.url,
    updatedAt: Date.now(),
  };
}

/** Takes a post back from the server queue, if it's there. */
async function withdraw(post: StoredPost): Promise<void> {
  if (!post.queueId) return;
  await call("DELETE", `/api/queue/${post.queueId}`);
}

/** Pulls the latest publish status of queued posts from the server and tidies up finished ones. */
async function syncQueue(posts: StoredPost[]): Promise<StoredPost[]> {
  const pending = posts.filter((p) => p.queueId && (p.status === "scheduled" || p.status === "publishing" || p.status === "failed"));
  if (!pending.length) return posts;
  let statuses: Record<string, QueueStatus | null>;
  try {
    statuses = await call<Record<string, QueueStatus | null>>("GET", `/api/queue?ids=${pending.map((p) => p.queueId).join(",")}`);
  } catch {
    return posts; // offline: show what we know
  }
  const d = await db();
  const updated = new Map<number, StoredPost>();
  for (const p of pending) {
    const q = statuses[p.queueId!];
    if (!q) continue; // just handed over and not visible yet, or already cleaned up
    const next = applyQueueStatus(p, q);
    if (next.status !== p.status || next.lastError !== p.lastError || next.scheduledAt !== p.scheduledAt) {
      await d.put("posts", next);
      updated.set(p.id, next);
    }
    // Once the phone knows a post went out, the server can forget it.
    if (q.status === "published") void call("DELETE", `/api/queue/${q.id}`).catch(() => undefined);
  }
  return posts.map((p) => updated.get(p.id) ?? p);
}

// --- The API the pages use ------------------------------------------------------------

export const api = {
  async config(): Promise<AppConfig> {
    const c = await call<Omit<AppConfig, "models">>("GET", "/api/config");
    serverConfig = { ...c, models: [...MODELS] };
    return serverConfig;
  },

  async me(): Promise<Me> {
    const server = await call<{ user: Me["user"]; linkedin: Me["linkedin"] }>("GET", "/api/me");
    await openAccount(server.user.key);
    const s = await getSettings();
    me = { ...server, settings: { hasApiKey: Boolean(s.apiKey), apiKeyMasked: s.apiKey ? mask(s.apiKey) : null, model: s.model } };
    return me;
  },

  devLogin: () => call("POST", "/auth/dev-login"),
  logout: () => call("POST", "/auth/logout"),

  async saveSettings(s: { apiKey?: string; model?: string }): Promise<void> {
    if (s.apiKey) await verifyApiKey(s.apiKey);
    await setSettings({ ...(s.apiKey ? { apiKey: s.apiKey } : {}), ...(s.model ? { model: s.model } : {}) });
  },
  removeApiKey: () => setSettings({ apiKey: null }),

  profile: getProfile,
  async saveProfile(p: Profile): Promise<Profile> {
    await (await db()).put("kv", p, "profile");
    return p;
  },
  async analyzeVoice(): Promise<{ voiceGuide: string }> {
    const profile = await getProfile();
    const voiceGuide = await analyzeVoice(await aiContext(), splitSamples(profile.writingSamples));
    await api.saveProfile({ ...profile, voiceGuide });
    return { voiceGuide };
  },

  async media(): Promise<Media[]> {
    const all = await (await db()).getAll("media");
    return all.sort((a, b) => b.createdAt - a.createdAt).map(publicMedia);
  },
  async mediaOne(id: number): Promise<Media> {
    return publicMedia((await storedMedia([id]))[0]);
  },
  /** The file itself, for re-transcribing. */
  async mediaBlob(id: number): Promise<Blob> {
    return (await storedMedia([id]))[0].blob;
  },
  async addMedia(m: Omit<StoredMedia, "id">): Promise<Media> {
    return publicMedia(await addRecord("media", m));
  },
  async updateMedia(id: number, patch: { transcript?: string; altText?: string; status?: "ready" | "failed"; error?: string | null }): Promise<Media> {
    const d = await db();
    const [m] = await storedMedia([id]);
    const next: StoredMedia = {
      ...m,
      ...(patch.transcript !== undefined ? { transcript: patch.transcript } : {}),
      ...(patch.altText !== undefined ? { altText: patch.altText } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    };
    await d.put("media", next);
    return publicMedia(next);
  },
  async deleteMedia(id: number): Promise<void> {
    await (await db()).delete("media", id);
    forget(id);
  },

  async generate(opts: GenerateOptions): Promise<{ drafts: PostDraft[] }> {
    const media = await storedMedia(opts.mediaIds);
    const { drafts, altTexts } = await generatePosts(await aiContext(), await getProfile(), media, opts);
    for (const { mediaId, altText } of altTexts) {
      const m = media.find((x) => x.id === mediaId);
      if (m && !m.altText && m.kind !== "audio") await api.updateMedia(m.id, { altText: altText.slice(0, 1_000) });
    }
    return { drafts };
  },
  async refine(text: string, instruction: string): Promise<{ text: string }> {
    return { text: await refinePost(await aiContext(), await getProfile(), text, instruction) };
  },
  async checkHook(text: string): Promise<HookReview> {
    return checkHook(await aiContext(), await getProfile(), text);
  },

  async inspirations(): Promise<Inspiration[]> {
    return (await (await db()).getAll("inspirations")).sort((a, b) => b.createdAt - a.createdAt);
  },
  async addInspiration(i: { text: string; author?: string; url?: string; screenshotMediaId?: number }): Promise<Inspiration> {
    const screenshot = i.screenshotMediaId ? (await storedMedia([i.screenshotMediaId]))[0] : undefined;
    const { text, analysis } = await analyzeInspiration(await aiContext(), { text: i.text, screenshot });
    return addRecord("inspirations", {
      text,
      author: i.author || null,
      url: i.url || null,
      screenshotMediaId: screenshot?.id ?? null,
      analysis,
      createdAt: Date.now(),
    });
  },
  async deleteInspiration(id: number): Promise<void> {
    await (await db()).delete("inspirations", id);
  },
  async remix(id: number, opts: { notes: string; mediaIds: number[]; variations?: number; length?: "short" | "medium" | "long" }): Promise<{ drafts: RemixDraft[] }> {
    const inspiration = await (await db()).get("inspirations", id);
    if (!inspiration) throw new ApiError("Saved post not found", 404);
    const drafts = await remixPosts(await aiContext(), await getProfile(), inspiration, await storedMedia(opts.mediaIds), { ...opts, inspirationId: id });
    return { drafts };
  },

  async posts(): Promise<Post[]> {
    const all = await syncQueue(await (await db()).getAll("posts"));
    return all.map(publicPost);
  },

  async createPost(input: SavePostInput): Promise<Post> {
    const now = Date.now();
    const post = await addRecord("posts", {
      text: input.text,
      mediaIds: input.mediaIds,
      visibility: input.visibility,
      status: "draft",
      scheduledAt: null,
      publishedAt: null,
      url: null,
      attempts: 0,
      lastError: null,
      source: input.source ?? null,
      inspirationId: input.inspirationId ?? null,
      createdAt: now,
      updatedAt: now,
      queueId: null,
    });
    return publicPost(await applyAction(post, input));
  },

  async updatePost(id: number, input: SavePostInput): Promise<Post> {
    const d = await db();
    const post = await d.get("posts", id);
    if (!post) throw new ApiError("Post not found", 404);
    if (post.status === "publishing" || post.status === "published") throw new ApiError(`This post is ${post.status} and can no longer be edited.`, 409);
    await withdraw(post);
    const edited: StoredPost = {
      ...post,
      text: input.text,
      mediaIds: input.mediaIds,
      visibility: input.visibility,
      status: "draft",
      scheduledAt: null,
      lastError: null,
      attempts: 0,
      queueId: null,
      updatedAt: Date.now(),
    };
    await d.put("posts", edited);
    return publicPost(await applyAction(edited, input));
  },

  async publishPost(id: number): Promise<Post> {
    const post = await (await db()).get("posts", id);
    if (!post) throw new ApiError("Post not found", 404);
    return publicPost(await publish(post, null));
  },

  async deletePost(id: number): Promise<void> {
    const d = await db();
    const post = await d.get("posts", id);
    if (!post) return;
    if (post.status === "publishing") throw new ApiError("This post is being published right now.", 409);
    if (post.status !== "published") await withdraw(post);
    await d.delete("posts", id);
  },
};

async function applyAction(post: StoredPost, input: SavePostInput): Promise<StoredPost> {
  if (input.action === "schedule") {
    if (!input.scheduledAt) throw new ApiError("Pick a time to schedule the post.", 400);
    return publish(post, input.scheduledAt);
  }
  if (input.action === "publish") return publish(post, null);
  return post;
}

/** Schedules (dueAt) or immediately publishes (null) a post via the server queue. */
async function publish(post: StoredPost, dueAt: number | null): Promise<StoredPost> {
  const d = await db();
  let status: QueueStatus;
  if (post.queueId && post.status === "failed" && dueAt === null) {
    // Retry in place: the server still has the files.
    status = await call<QueueStatus>("POST", `/api/queue/${post.queueId}/retry`).catch(async () => {
      await withdraw(post).catch(() => undefined);
      return handOver(post, null);
    });
  } else {
    if (post.queueId) await withdraw(post);
    status = await handOver(post, dueAt);
  }
  const next = applyQueueStatus(post, status);
  await d.put("posts", next);
  return next;
}

export const mediaUrl = (id: number) => urls.get(id)?.file ?? "";
export const previewUrl = (id: number) => urls.get(id)?.preview ?? "";
