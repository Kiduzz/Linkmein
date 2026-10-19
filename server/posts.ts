import { get, all, now, run, type MediaRow, type PostRow, type PostStatus } from "./db.js";
import { config } from "./config.js";
import { createPost, LinkedInError, personUrn, postUrl, uploadImage, uploadVideo, waitForVideo, type PostContent } from "./linkedin.js";
import { getLinkedInToken, getUser } from "./users.js";
import { getMediaMany, MediaError } from "./media/library.js";
import { readFile, readRange } from "./storage.js";
import { LINKEDIN_POST_LIMIT } from "../shared/types.js";

export const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5 * 60_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getPost(userId: number, id: number): Promise<PostRow | undefined> {
  return get<PostRow>("SELECT * FROM posts WHERE id = ? AND user_id = ?", [id, userId]);
}

export function listPosts(userId: number): Promise<PostRow[]> {
  return all<PostRow>("SELECT * FROM posts WHERE user_id = ? ORDER BY COALESCE(scheduled_at, published_at, updated_at) DESC", [userId]);
}

export interface PostInput {
  text: string;
  mediaIds: number[];
  visibility: "PUBLIC" | "CONNECTIONS";
  source?: string | null;
  inspirationId?: number | null;
}

/** LinkedIn accepts text alone, 1-20 images, or a single video. Audio is AI-only material. */
export async function validatePostInput(userId: number, input: PostInput): Promise<MediaRow[]> {
  if (!input.text.trim() && !input.mediaIds.length) throw new HttpError(400, "A post needs text or media.");
  if (input.text.length > LINKEDIN_POST_LIMIT) throw new HttpError(400, `LinkedIn posts are limited to ${LINKEDIN_POST_LIMIT} characters.`);
  let media: MediaRow[];
  try {
    media = await getMediaMany(userId, input.mediaIds);
  } catch (err) {
    if (err instanceof MediaError) throw new HttpError(400, err.message);
    throw err;
  }
  if (media.some((m) => m.kind === "audio")) throw new HttpError(400, "Audio can't be attached to a LinkedIn post. It's only used to write the text.");
  const videos = media.filter((m) => m.kind === "video");
  if (videos.length > 1 || (videos.length === 1 && media.length > 1)) throw new HttpError(400, "A LinkedIn post can have one video, or up to 20 images, but not both.");
  if (media.length > 20) throw new HttpError(400, "A LinkedIn post can have at most 20 images.");
  return media;
}

export async function createPostRow(userId: number, input: PostInput, status: PostStatus, scheduledAt: number | null): Promise<PostRow> {
  await validatePostInput(userId, input);
  const t = now();
  const result = await run(
    `INSERT INTO posts (user_id, text, media_ids, status, scheduled_at, visibility, source, inspiration_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, input.text, JSON.stringify(input.mediaIds), status, scheduledAt, input.visibility, input.source ?? null, input.inspirationId ?? null, t, t],
  );
  return (await getPost(userId, result.lastId))!;
}

const EDITABLE: PostStatus[] = ["draft", "scheduled", "failed"];

export async function updatePostRow(userId: number, id: number, input: PostInput, status: PostStatus, scheduledAt: number | null): Promise<PostRow> {
  const post = await getPost(userId, id);
  if (!post) throw new HttpError(404, "Post not found");
  if (!EDITABLE.includes(post.status)) throw new HttpError(409, `This post is ${post.status} and can no longer be edited.`);
  await validatePostInput(userId, input);
  const result = await run(
    `UPDATE posts SET text = ?, media_ids = ?, visibility = ?, status = ?, scheduled_at = ?, attempts = 0, last_error = NULL, updated_at = ?
     WHERE id = ? AND status IN ('draft', 'scheduled', 'failed')`,
    [input.text, JSON.stringify(input.mediaIds), input.visibility, status, scheduledAt, now(), id],
  );
  if (result.changes !== 1) throw new HttpError(409, "This post started publishing and can no longer be edited.");
  return (await getPost(userId, id))!;
}

export async function deletePostRow(userId: number, id: number): Promise<void> {
  const post = await getPost(userId, id);
  if (!post) return;
  if (post.status === "publishing") throw new HttpError(409, "This post is being published right now.");
  await run("DELETE FROM posts WHERE id = ?", [id]);
}

/** Atomically moves a post into "publishing" so two workers can never publish it twice. */
export async function claimPost(id: number, from: PostStatus[]): Promise<boolean> {
  const placeholders = from.map(() => "?").join(", ");
  const result = await run(
    `UPDATE posts SET status = 'publishing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
    [now(), id, ...from],
  );
  return result.changes === 1;
}

export type Publisher = (post: PostRow) => Promise<string>;

export const publishToLinkedIn: Publisher = async (post) => {
  const user = await getUser(post.user_id);
  if (!user) throw new LinkedInError("User no longer exists", 401);
  const media = await getMediaMany(user.id, JSON.parse(post.media_ids) as number[]);
  if (config.linkedin.dryRun) {
    console.log(`[dry run] Would publish post ${post.id} with ${media.length} media:\n${post.text}`);
    return `urn:li:share:dryrun-${post.id}-${Date.now()}`;
  }
  const token = await getLinkedInToken(user);
  const owner = personUrn(user.linkedin_sub);

  let content: PostContent = { kind: "none" };
  const video = media.find((m) => m.kind === "video");
  if (video) {
    const urn = await uploadVideo(token, owner, video.size, (start, end) => readRange(video.file_key, start, end));
    await waitForVideo(token, urn);
    content = { kind: "video", urn };
  } else if (media.length) {
    const images = [];
    for (const m of media) images.push({ urn: await uploadImage(token, owner, await readFile(m.file_key)), altText: m.alt_text ?? undefined });
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
  const post = (await get<PostRow>("SELECT * FROM posts WHERE id = ?", [id]))!;
  try {
    const urn = await publisher(post);
    await run("UPDATE posts SET status = 'published', linkedin_urn = ?, published_at = ?, last_error = NULL, updated_at = ? WHERE id = ?", [
      urn,
      now(),
      now(),
      id,
    ]);
  } catch (err) {
    const message = (err as Error).message;
    const retryable = err instanceof LinkedInError ? err.isRetryable : false;
    if (retryable && post.attempts < MAX_ATTEMPTS) {
      const retryAt = now() + RETRY_BASE_MS * post.attempts;
      await run("UPDATE posts SET status = 'scheduled', scheduled_at = ?, last_error = ?, updated_at = ? WHERE id = ?", [
        retryAt,
        `${message} (retrying)`,
        now(),
        id,
      ]);
    } else {
      await run("UPDATE posts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", [message, now(), id]);
    }
    console.error(`Publishing post ${id} failed:`, message);
  }
  return (await get<PostRow>("SELECT * FROM posts WHERE id = ?", [id]))!;
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
