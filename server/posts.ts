import fs from "node:fs/promises";
import sharp from "sharp";
import { db, now, type MediaRow, type PostRow, type PostStatus } from "./db.js";
import { config } from "./config.js";
import { createPost, LinkedInError, personUrn, postUrl, uploadImage, uploadVideo, waitForVideo, type PostContent } from "./linkedin.js";
import { getLinkedInToken, getUser } from "./users.js";
import { getMediaMany } from "./media/library.js";
import { LINKEDIN_POST_LIMIT } from "../shared/types.js";

export const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5 * 60_000;

export function getPost(userId: number, id: number): PostRow | undefined {
  return db().prepare("SELECT * FROM posts WHERE id = ? AND user_id = ?").get(id, userId) as PostRow | undefined;
}

export function listPosts(userId: number): PostRow[] {
  return db()
    .prepare("SELECT * FROM posts WHERE user_id = ? ORDER BY COALESCE(scheduled_at, published_at, updated_at) DESC")
    .all(userId) as PostRow[];
}

export interface PostInput {
  text: string;
  mediaIds: number[];
  visibility: "PUBLIC" | "CONNECTIONS";
  source?: string | null;
  inspirationId?: number | null;
}

/** LinkedIn accepts text alone, 1-20 images, or a single video. Audio is AI-only material. */
export function validatePostInput(userId: number, input: PostInput): MediaRow[] {
  if (!input.text.trim() && !input.mediaIds.length) throw new HttpError(400, "A post needs text or media.");
  if (input.text.length > LINKEDIN_POST_LIMIT) throw new HttpError(400, `LinkedIn posts are limited to ${LINKEDIN_POST_LIMIT} characters.`);
  let media: MediaRow[];
  try {
    media = getMediaMany(userId, input.mediaIds);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  if (media.some((m) => m.kind === "audio")) throw new HttpError(400, "Audio can't be attached to a LinkedIn post. It's only used to write the text.");
  const videos = media.filter((m) => m.kind === "video");
  if (videos.length > 1 || (videos.length === 1 && media.length > 1)) throw new HttpError(400, "A LinkedIn post can have one video, or up to 20 images, but not both.");
  if (media.length > 20) throw new HttpError(400, "A LinkedIn post can have at most 20 images.");
  return media;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createPostRow(userId: number, input: PostInput, status: PostStatus, scheduledAt: number | null): PostRow {
  validatePostInput(userId, input);
  const t = now();
  const result = db()
    .prepare(
      `INSERT INTO posts (user_id, text, media_ids, status, scheduled_at, visibility, source, inspiration_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, input.text, JSON.stringify(input.mediaIds), status, scheduledAt, input.visibility, input.source ?? null, input.inspirationId ?? null, t, t);
  return getPost(userId, Number(result.lastInsertRowid))!;
}

const EDITABLE: PostStatus[] = ["draft", "scheduled", "failed"];

export function updatePostRow(userId: number, id: number, input: PostInput, status: PostStatus, scheduledAt: number | null): PostRow {
  const post = getPost(userId, id);
  if (!post) throw new HttpError(404, "Post not found");
  if (!EDITABLE.includes(post.status)) throw new HttpError(409, `This post is ${post.status} and can no longer be edited.`);
  validatePostInput(userId, input);
  db()
    .prepare(
      `UPDATE posts SET text = ?, media_ids = ?, visibility = ?, status = ?, scheduled_at = ?, attempts = 0, last_error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('draft', 'scheduled', 'failed')`,
    )
    .run(input.text, JSON.stringify(input.mediaIds), input.visibility, status, scheduledAt, now(), id);
  return getPost(userId, id)!;
}

export function deletePostRow(userId: number, id: number): void {
  const post = getPost(userId, id);
  if (!post) return;
  if (post.status === "publishing") throw new HttpError(409, "This post is being published right now.");
  db().prepare("DELETE FROM posts WHERE id = ?").run(id);
}

/** Atomically moves a post into "publishing" so two workers can never publish it twice. */
export function claimPost(id: number, from: PostStatus[]): boolean {
  const placeholders = from.map(() => "?").join(", ");
  const result = db()
    .prepare(`UPDATE posts SET status = 'publishing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
    .run(now(), id, ...from);
  return result.changes === 1;
}

async function linkedinImage(m: MediaRow): Promise<Buffer> {
  // LinkedIn takes JPEG, PNG and GIF. Bake in EXIF rotation and convert anything else to JPEG.
  if (m.mime === "image/gif" || m.mime === "image/png") return fs.readFile(m.path);
  return sharp(m.path).rotate().jpeg({ quality: 92 }).toBuffer();
}

export type Publisher = (post: PostRow) => Promise<string>;

export const publishToLinkedIn: Publisher = async (post) => {
  const user = getUser(post.user_id);
  if (!user) throw new LinkedInError("User no longer exists", 401);
  const media = getMediaMany(user.id, JSON.parse(post.media_ids) as number[]);
  if (config.linkedin.dryRun) {
    console.log(`[dry run] Would publish post ${post.id} with ${media.length} media:\n${post.text}`);
    return `urn:li:share:dryrun-${post.id}-${Date.now()}`;
  }
  const token = await getLinkedInToken(user);
  const owner = personUrn(user.linkedin_sub);

  let content: PostContent = { kind: "none" };
  const video = media.find((m) => m.kind === "video");
  if (video) {
    const urn = await uploadVideo(token, owner, video.path);
    await waitForVideo(token, urn);
    content = { kind: "video", urn };
  } else if (media.length) {
    const images = [];
    for (const m of media) images.push({ urn: await uploadImage(token, owner, await linkedinImage(m)), altText: m.alt_text ?? undefined });
    content = { kind: "image", images };
  }
  return createPost(token, { author: owner, text: post.text, visibility: post.visibility, content });
};

let publisher: Publisher = publishToLinkedIn;
/** Tests replace the LinkedIn call. */
export function setPublisher(p: Publisher): void {
  publisher = p;
}

/** Publishes a post that has already been claimed, recording success, a retry, or failure. */
export async function publishClaimed(id: number): Promise<PostRow> {
  const post = db().prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRow;
  try {
    const urn = await publisher(post);
    db()
      .prepare("UPDATE posts SET status = 'published', linkedin_urn = ?, published_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(urn, now(), now(), id);
  } catch (err) {
    const message = (err as Error).message;
    const retryable = err instanceof LinkedInError ? err.isRetryable : false;
    if (retryable && post.attempts < MAX_ATTEMPTS) {
      const retryAt = now() + RETRY_BASE_MS * post.attempts;
      db()
        .prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(retryAt, `${message} (retrying)`, now(), id);
    } else {
      db().prepare("UPDATE posts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(message, now(), id);
    }
    console.error(`Publishing post ${id} failed:`, message);
  }
  return db().prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRow;
}

export function publicPost(p: PostRow) {
  return {
    id: p.id,
    text: p.text,
    mediaIds: JSON.parse(p.media_ids) as number[],
    status: p.status,
    scheduledAt: p.scheduled_at,
    publishedAt: p.published_at,
    url: p.linkedin_urn && !p.linkedin_urn.includes("dryrun") ? postUrl(p.linkedin_urn) : null,
    attempts: p.attempts,
    lastError: p.last_error,
    visibility: p.visibility,
    source: p.source,
    inspirationId: p.inspiration_id,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}
