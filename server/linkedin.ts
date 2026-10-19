import fs from "node:fs/promises";
import { config } from "./config.js";

// Thin client for the LinkedIn APIs Linkmein uses:
//  - OAuth 2.0 + OpenID Connect ("Sign In with LinkedIn using OpenID Connect")
//  - Posts, Images and Videos APIs ("Share on LinkedIn", scope w_member_social)

const AUTH_BASE = "https://www.linkedin.com/oauth/v2";
const API_BASE = "https://api.linkedin.com";
export const LINKEDIN_SCOPES = ["openid", "profile", "email", "w_member_social"];

export class LinkedInError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "LinkedInError";
  }

  /** The token is missing, expired or revoked; retrying won't help until the user reconnects. */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /** Worth retrying later: rate limits and LinkedIn-side failures. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
}

export interface LinkedInUser {
  sub: string;
  name: string;
  email: string | null;
  picture: string | null;
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.linkedin.clientId,
    redirect_uri: config.linkedin.redirectUri,
    state,
    scope: LINKEDIN_SCOPES.join(" "),
  });
  return `${AUTH_BASE}/authorization?${params}`;
}

async function readError(res: Response): Promise<LinkedInError> {
  const text = await res.text().catch(() => "");
  let body: unknown = text;
  let message = text || res.statusText;
  try {
    body = JSON.parse(text);
    const b = body as { message?: string; error_description?: string; error?: string };
    message = b.message ?? b.error_description ?? b.error ?? message;
  } catch {
    // Not JSON; keep the raw text.
  }
  return new LinkedInError(`LinkedIn ${res.status}: ${message}`, res.status, body);
}

async function request(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new LinkedInError(`Could not reach LinkedIn: ${(err as Error).message}`, 0);
  }
  if (!res.ok) throw await readError(res);
  return res;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const res = await request(`${AUTH_BASE}/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...params,
      client_id: config.linkedin.clientId,
      client_secret: config.linkedin.clientSecret,
    }),
  });
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  };
  const issued = Date.now();
  return {
    accessToken: json.access_token,
    expiresAt: issued + json.expires_in * 1000,
    refreshToken: json.refresh_token ?? null,
    refreshExpiresAt: json.refresh_token_expires_in ? issued + json.refresh_token_expires_in * 1000 : null,
  };
}

export function exchangeCode(code: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: config.linkedin.redirectUri });
}

/** Only apps approved for programmatic refresh get refresh tokens; everyone else re-authorizes every 60 days. */
export function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function fetchUserInfo(accessToken: string): Promise<LinkedInUser> {
  const res = await request(`${API_BASE}/v2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json()) as { sub: string; name?: string; given_name?: string; family_name?: string; email?: string; picture?: string };
  return {
    sub: json.sub,
    name: json.name || [json.given_name, json.family_name].filter(Boolean).join(" ") || "LinkedIn member",
    email: json.email ?? null,
    picture: json.picture ?? null,
  };
}

export const personUrn = (sub: string) => `urn:li:person:${sub}`;

function restHeaders(accessToken: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": config.linkedin.apiVersion,
    "X-Restli-Protocol-Version": "2.0.0",
    ...extra,
  };
}

// --- Commentary formatting -------------------------------------------------

// The Posts API reads commentary as "little text": these characters are markup and
// must be backslash-escaped, or LinkedIn silently truncates or mangles the post.
const RESERVED = /[\\|{}@[\]()<>#*_~]/g;

export function escapeLittleText(text: string): string {
  return text.replace(RESERVED, (c) => `\\${c}`);
}

// A hashtag starts at a word boundary and contains at least one letter, so "C#" and "#1" stay literal.
const HASHTAG = /(^|[^\p{L}\p{N}_&/])#([\p{L}\p{N}]*\p{L}[\p{L}\p{N}]*)/gu;

/** Converts plain post text to LinkedIn little text, turning #hashtags into real hashtag links. */
export function toLittleText(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(HASHTAG)) {
    const start = match.index + match[1].length;
    out += escapeLittleText(text.slice(last, start));
    out += `{hashtag|\\#|${match[2]}}`;
    last = start + 1 + match[2].length;
  }
  return out + escapeLittleText(text.slice(last));
}

// --- Media uploads -----------------------------------------------------------

export async function uploadImage(accessToken: string, owner: string, data: Buffer): Promise<string> {
  const init = await request(`${API_BASE}/rest/images?action=initializeUpload`, {
    method: "POST",
    headers: restHeaders(accessToken, { "Content-Type": "application/json" }),
    body: JSON.stringify({ initializeUploadRequest: { owner } }),
  });
  const { value } = (await init.json()) as { value: { uploadUrl: string; image: string } };
  await request(value.uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(data),
  });
  return value.image;
}

interface VideoUploadInstruction {
  uploadUrl: string;
  firstByte: number;
  lastByte: number;
}

export async function uploadVideo(accessToken: string, owner: string, filePath: string): Promise<string> {
  const { size } = await fs.stat(filePath);
  const init = await request(`${API_BASE}/rest/videos?action=initializeUpload`, {
    method: "POST",
    headers: restHeaders(accessToken, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false },
    }),
  });
  const { value } = (await init.json()) as {
    value: { video: string; uploadToken: string; uploadInstructions: VideoUploadInstruction[] };
  };

  const etags: string[] = [];
  const handle = await fs.open(filePath, "r");
  try {
    for (const part of value.uploadInstructions) {
      const length = part.lastByte - part.firstByte + 1;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, part.firstByte);
      const res = await request(part.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(chunk),
      });
      const etag = res.headers.get("etag");
      if (!etag) throw new LinkedInError("LinkedIn video upload returned no ETag", 502);
      etags.push(etag);
    }
  } finally {
    await handle.close();
  }

  await request(`${API_BASE}/rest/videos?action=finalizeUpload`, {
    method: "POST",
    headers: restHeaders(accessToken, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      finalizeUploadRequest: { video: value.video, uploadToken: value.uploadToken, uploadedPartIds: etags },
    }),
  });
  return value.video;
}

/** LinkedIn processes videos asynchronously; posting before it's AVAILABLE fails. */
export async function waitForVideo(
  accessToken: string,
  videoUrn: string,
  { timeoutMs = 10 * 60_000, pollMs = 5_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(`${API_BASE}/rest/videos/${encodeURIComponent(videoUrn)}`, {
      headers: restHeaders(accessToken),
    });
    const { status } = (await res.json()) as { status?: string };
    if (status === "AVAILABLE") return;
    if (status === "PROCESSING_FAILED") throw new LinkedInError("LinkedIn could not process the video", 422);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new LinkedInError("Timed out waiting for LinkedIn to process the video", 504);
}

// --- Posts ---------------------------------------------------------------------

export type PostContent =
  | { kind: "none" }
  | { kind: "image"; images: { urn: string; altText?: string }[] }
  | { kind: "video"; urn: string; title?: string };

export interface CreatePostInput {
  author: string;
  text: string;
  visibility: "PUBLIC" | "CONNECTIONS";
  content: PostContent;
}

export function buildPostBody(input: CreatePostInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    author: input.author,
    commentary: toLittleText(input.text),
    visibility: input.visibility,
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  const c = input.content;
  if (c.kind === "image" && c.images.length === 1) {
    body.content = { media: { id: c.images[0].urn, altText: c.images[0].altText ?? "" } };
  } else if (c.kind === "image" && c.images.length > 1) {
    body.content = { multiImage: { images: c.images.map((i) => ({ id: i.urn, altText: i.altText ?? "" })) } };
  } else if (c.kind === "video") {
    body.content = { media: { id: c.urn, ...(c.title ? { title: c.title } : {}) } };
  }
  return body;
}

export async function createPost(accessToken: string, input: CreatePostInput): Promise<string> {
  const res = await request(`${API_BASE}/rest/posts`, {
    method: "POST",
    headers: restHeaders(accessToken, { "Content-Type": "application/json" }),
    body: JSON.stringify(buildPostBody(input)),
  });
  const urn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
  if (!urn) throw new LinkedInError("LinkedIn accepted the post but returned no id", 502);
  return urn;
}

export const postUrl = (urn: string) => `https://www.linkedin.com/feed/update/${urn}/`;
