import type { GenerateOptions, InspirationAnalysis, PostDraft, Profile, RemixDraft } from "../../shared/types";

export interface Me {
  user: { id: number; name: string; email: string | null; picture: string | null };
  settings: { hasApiKey: boolean; apiKeyMasked: string | null; model: string; timezone: string | null };
  linkedin: { connected: boolean; expiresAt: number | null; dryRun: boolean };
}

export interface AppConfig {
  linkedinConfigured: boolean;
  devLogin: boolean;
  models: { id: string; label: string }[];
  storage: "local" | "blob";
  maxUploadMb: number;
}

export interface RegisterMediaInput {
  kind: Media["kind"];
  name: string;
  mime: string;
  fileKey: string;
  previewKey?: string;
  frameKeys?: string[];
  durationS?: number;
  width?: number;
  height?: number;
  transcript?: string;
  status: "processing" | "ready";
  error?: string;
}

export interface Media {
  id: number;
  kind: "image" | "audio" | "video";
  name: string;
  mime: string;
  size: number;
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

export const api = {
  config: () => call<AppConfig>("GET", "/api/config"),
  me: () => call<Me>("GET", "/api/me"),
  devLogin: () => call("POST", "/auth/dev-login"),
  logout: () => call("POST", "/auth/logout"),
  saveSettings: (s: { apiKey?: string; model?: string; timezone?: string }) => call("PUT", "/api/settings", s),
  removeApiKey: () => call("DELETE", "/api/settings/api-key"),

  profile: () => call<Profile>("GET", "/api/profile"),
  saveProfile: (p: Profile) => call<Profile>("PUT", "/api/profile", p),
  analyzeVoice: () => call<{ voiceGuide: string }>("POST", "/api/profile/analyze-voice"),

  media: () => call<Media[]>("GET", "/api/media"),
  mediaOne: (id: number) => call<Media>("GET", `/api/media/${id}`),
  registerMedia: (m: RegisterMediaInput) => call<Media>("POST", "/api/media", m),
  updateMedia: (id: number, patch: { transcript?: string; altText?: string; status?: "ready" | "failed"; error?: string | null }) =>
    call<Media>("PATCH", `/api/media/${id}`, patch),
  deleteMedia: (id: number) => call("DELETE", `/api/media/${id}`),

  generate: (opts: GenerateOptions) => call<{ drafts: PostDraft[] }>("POST", "/api/ai/generate", opts),
  refine: (text: string, instruction: string) => call<{ text: string }>("POST", "/api/ai/refine", { text, instruction }),

  inspirations: () => call<Inspiration[]>("GET", "/api/inspirations"),
  addInspiration: (i: { text: string; author?: string; url?: string; screenshotMediaId?: number }) =>
    call<Inspiration>("POST", "/api/inspirations", i),
  deleteInspiration: (id: number) => call("DELETE", `/api/inspirations/${id}`),
  remix: (id: number, opts: { notes: string; mediaIds: number[]; variations?: number; length?: string }) =>
    call<{ drafts: RemixDraft[] }>("POST", `/api/inspirations/${id}/remix`, opts),

  posts: () => call<Post[]>("GET", "/api/posts"),
  createPost: (p: SavePostInput) => call<Post>("POST", "/api/posts", p),
  updatePost: (id: number, p: SavePostInput) => call<Post>("PUT", `/api/posts/${id}`, p),
  publishPost: (id: number) => call<Post>("POST", `/api/posts/${id}/publish`),
  deletePost: (id: number) => call("DELETE", `/api/posts/${id}`),
};

export const mediaUrl = (id: number) => `/api/media/${id}/file`;
export const previewUrl = (id: number) => `/api/media/${id}/preview`;
