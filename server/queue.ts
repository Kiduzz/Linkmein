import { config } from "./config.js";
import { createPost, LinkedInError, personUrn, postUrl, uploadImage, uploadVideo, waitForVideo, type PostContent } from "./linkedin.js";
import { getAccount, getLinkedInToken } from "./accounts.js";
import { deleteFiles, ownsKey, readFile, readJson, readRange, sizeOf, updateJson, writeJson } from "./storage.js";
import { LINKEDIN_POST_LIMIT } from "../shared/types.js";

// The publish queue. A phone hands over a post (text + media files) when it's
// scheduled; the server publishes it at the right time and keeps only its outcome
// until the phone has synced it. One small index lists what's pending, so the
// scheduler's frequent checks are cheap cached reads.

export const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5 * 60_000;
const STALE_PUBLISHING_MS = 30 * 60_000;
const INDEX = "queue/index.json";
const itemPath = (id: string) => `queue/items/${id}.json`;

export type QueueStatus = "scheduled" | "publishing" | "published" | "failed";

export interface QueueMedia {
  key: string;
  kind: "image" | "video";
  mime: string;
  size: number;
  altText?: string;
}

export interface QueueItem {
  id: string;
  accountKey: string;
  text: string;
  visibility: "PUBLIC" | "CONNECTIONS";
  dueAt: number;
  media: QueueMedia[];
  status: QueueStatus;
  attempts: number;
  lastError: string | null;
  urn: string | null;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface IndexEntry {
  id: string;
  dueAt: number;
  status: "scheduled" | "publishing";
  since: number;
}

interface Index {
  entries: IndexEntry[];
}

export class QueueError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ID = /^[A-Za-z0-9-]{8,64}$/;

function setEntry(entries: IndexEntry[], entry: IndexEntry | null, id: string): IndexEntry[] {
  const rest = entries.filter((e) => e.id !== id);
  return entry ? [...rest, entry] : rest;
}

const updateIndex = (change: (entries: IndexEntry[]) => IndexEntry[]) =>
  updateJson<Index>(INDEX, { entries: [] }, (index) => ({ entries: change(index.entries) }));

export interface EnqueueInput {
  id: string;
  text: string;
  visibility: "PUBLIC" | "CONNECTIONS";
  dueAt: number;
  media: { key: string; kind: "image" | "video"; mime: string; altText?: string }[];
}

/** LinkedIn accepts text alone, 1-20 images, or a single video. */
function validate(accountKey: string, input: EnqueueInput): void {
  if (!ID.test(input.id)) throw new QueueError(400, "Invalid post id.");
  if (!input.text.trim() && !input.media.length) throw new QueueError(400, "A post needs text or media.");
  if (input.text.length > LINKEDIN_POST_LIMIT) throw new QueueError(400, `LinkedIn posts are limited to ${LINKEDIN_POST_LIMIT} characters.`);
  const videos = input.media.filter((m) => m.kind === "video").length;
  if (videos > 1 || (videos === 1 && input.media.length > 1)) throw new QueueError(400, "A LinkedIn post can have one video, or up to 20 images, but not both.");
  if (input.media.length > 20) throw new QueueError(400, "A LinkedIn post can have at most 20 images.");
  for (const m of input.media) {
    if (!ownsKey(accountKey, m.key)) throw new QueueError(403, "Invalid upload key.");
    if (m.kind === "image" && !/^image\/(jpeg|png|gif)$/.test(m.mime)) throw new QueueError(400, "Images must be JPEG, PNG or GIF.");
    if (m.kind === "video" && !m.mime.startsWith("video/")) throw new QueueError(400, "Invalid video type.");
  }
}

export async function enqueue(accountKey: string, input: EnqueueInput): Promise<QueueItem> {
  validate(accountKey, input);
  // Trust the stored bytes, not the browser, for size and existence.
  const media: QueueMedia[] = [];
  for (const m of input.media) {
    const size = await sizeOf(m.key);
    if (size === null) throw new QueueError(400, "An attachment didn't finish uploading. Please try again.");
    if (size > config.maxUploadMb * 1024 * 1024) throw new QueueError(400, `Files are limited to ${config.maxUploadMb} MB.`);
    media.push({ key: m.key, kind: m.kind, mime: m.mime, size, altText: m.altText?.slice(0, 1000) });
  }
  const now = Date.now();
  const item: QueueItem = {
    id: input.id,
    accountKey,
    text: input.text,
    visibility: input.visibility,
    dueAt: input.dueAt,
    media,
    status: "scheduled",
    attempts: 0,
    lastError: null,
    urn: null,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  if (!(await writeJson(itemPath(item.id), item, { create: true }))) throw new QueueError(409, "This post is already scheduled.");
  await updateIndex((entries) => setEntry(entries, { id: item.id, dueAt: item.dueAt, status: "scheduled", since: now }, item.id));
  return item;
}

export async function getItem(accountKey: string, id: string, { fresh = false } = {}): Promise<QueueItem | null> {
  if (!ID.test(id)) return null;
  const item = (await readJson<QueueItem>(itemPath(id), { fresh }))?.value ?? null;
  return item && item.accountKey === accountKey ? item : null;
}

/** Removes a post from the queue along with its files. Refuses while it's being published. */
export async function removeItem(accountKey: string, id: string): Promise<void> {
  const item = await getItem(accountKey, id, { fresh: true });
  if (!item) return;
  if (item.status === "publishing") throw new QueueError(409, "This post is being published right now.");
  await updateIndex((entries) => setEntry(entries, null, id));
  await deleteFiles([...item.media.map((m) => m.key), itemPath(id)]);
}

/** Puts a failed post back in line to publish right away. */
export async function retryItem(accountKey: string, id: string): Promise<QueueItem> {
  const current = await readJson<QueueItem>(itemPath(id), { fresh: true });
  if (!current || current.value.accountKey !== accountKey) throw new QueueError(404, "Post not found in the queue.");
  if (current.value.status !== "failed") throw new QueueError(409, `This post is ${current.value.status}.`);
  const now = Date.now();
  const item: QueueItem = { ...current.value, status: "scheduled", dueAt: now, attempts: 0, lastError: null, updatedAt: now };
  if (!(await writeJson(itemPath(id), item, { ifMatch: current.etag }))) throw new QueueError(409, "The post changed; try again.");
  await updateIndex((entries) => setEntry(entries, { id, dueAt: now, status: "scheduled", since: now }, id));
  return item;
}

/** Atomically moves a due post into "publishing" so two runs can never publish it twice. */
export async function claim(id: string, at = Date.now()): Promise<QueueItem | null> {
  const current = await readJson<QueueItem>(itemPath(id), { fresh: true });
  if (!current) {
    await updateIndex((entries) => setEntry(entries, null, id)); // removed while listed
    return null;
  }
  const item = current.value;
  if (item.status !== "scheduled" || item.dueAt > at) return null;
  const claimed: QueueItem = { ...item, status: "publishing", attempts: item.attempts + 1, updatedAt: Date.now() };
  if (!(await writeJson(itemPath(id), claimed, { ifMatch: current.etag }))) return null;
  await updateIndex((entries) => setEntry(entries, { id, dueAt: item.dueAt, status: "publishing", since: claimed.updatedAt }, id));
  return claimed;
}

export type Publisher = (item: QueueItem) => Promise<string>;

export const publishToLinkedIn: Publisher = async (item) => {
  if (config.linkedin.dryRun) {
    console.log(`[dry run] Would publish ${item.id} with ${item.media.length} media:\n${item.text}`);
    return `urn:li:share:dryrun-${item.id}`;
  }
  const account = await getAccount(item.accountKey, { fresh: true });
  if (!account) throw new LinkedInError("LinkedIn account not found. Sign in again.", 401);
  const token = await getLinkedInToken(account);
  const owner = personUrn(account.sub);

  let content: PostContent = { kind: "none" };
  const video = item.media.find((m) => m.kind === "video");
  if (video) {
    const urn = await uploadVideo(token, owner, video.size, (start, end) => readRange(video.key, start, end));
    await waitForVideo(token, urn);
    content = { kind: "video", urn };
  } else if (item.media.length) {
    const images = [];
    for (const m of item.media) images.push({ urn: await uploadImage(token, owner, await readFile(m.key)), altText: m.altText });
    content = { kind: "image", images };
  }
  return createPost(token, { author: owner, text: item.text, visibility: item.visibility, content });
};

let publisher: Publisher = publishToLinkedIn;
/** Tests replace the LinkedIn call. */
export function setPublisher(p: Publisher): void {
  publisher = p;
}

/** Publishes a claimed post and records success, a retry, or failure. */
export async function publishClaimed(item: QueueItem): Promise<QueueItem> {
  let next: QueueItem;
  try {
    const urn = await publisher(item);
    next = { ...item, status: "published", urn, publishedAt: Date.now(), lastError: null, updatedAt: Date.now() };
  } catch (err) {
    const message = (err as Error).message;
    const retryable = err instanceof LinkedInError ? err.isRetryable : false;
    next =
      retryable && item.attempts < MAX_ATTEMPTS
        ? { ...item, status: "scheduled", dueAt: Date.now() + RETRY_BASE_MS * item.attempts, lastError: `${message} (retrying)`, updatedAt: Date.now() }
        : { ...item, status: "failed", lastError: message, updatedAt: Date.now() };
    console.error(`Publishing ${item.id} failed:`, message);
  }
  await writeJson(itemPath(item.id), next);
  await updateIndex((entries) =>
    setEntry(entries, next.status === "scheduled" ? { id: next.id, dueAt: next.dueAt, status: "scheduled", since: Date.now() } : null, next.id),
  );
  // Published posts no longer need their files; failed ones keep them for a retry.
  if (next.status === "published") await deleteFiles(next.media.map((m) => m.key));
  return next;
}

/**
 * Publishes everything that's due, stopping before `budgetMs` so a serverless run
 * never gets cut off mid-post. Returns how many posts were attempted.
 */
export async function runDue(at = Date.now(), budgetMs = Infinity): Promise<{ attempted: number; recovered: number }> {
  const started = Date.now();
  // A cached read: free on Vercel Blob, and at most a minute stale. Claims re-check freshly.
  const entries = (await readJson<Index>(INDEX))?.value.entries ?? [];
  let recovered = 0;
  for (const e of entries.filter((x) => x.status === "publishing" && x.since < at - STALE_PUBLISHING_MS)) {
    if (await recoverInterrupted(e.id, at)) recovered++;
  }
  let attempted = 0;
  for (const e of entries.filter((x) => x.status === "scheduled" && x.dueAt <= at).sort((a, b) => a.dueAt - b.dueAt)) {
    if (Date.now() - started > budgetMs) break;
    const item = await claim(e.id, at);
    if (!item) continue;
    attempted++;
    await publishClaimed(item);
  }
  return { attempted, recovered };
}

/**
 * A post stuck in "publishing" means a run stopped mid-publish. It may or may not
 * have reached LinkedIn, so we fail it rather than risk a duplicate post.
 */
export async function recoverInterrupted(id: string, at = Date.now(), staleMs = STALE_PUBLISHING_MS): Promise<boolean> {
  const current = await readJson<QueueItem>(itemPath(id), { fresh: true });
  if (!current || current.value.status !== "publishing" || current.value.updatedAt >= at - staleMs) return false;
  const failed: QueueItem = {
    ...current.value,
    status: "failed",
    lastError: "Publishing was interrupted. Check your LinkedIn profile before retrying so it isn't posted twice.",
    updatedAt: Date.now(),
  };
  if (!(await writeJson(itemPath(id), failed, { ifMatch: current.etag }))) return false;
  await updateIndex((entries) => setEntry(entries, null, id));
  return true;
}

/** What the phone sees about a queued post. */
export function publicItem(item: QueueItem) {
  return {
    id: item.id,
    status: item.status,
    dueAt: item.dueAt,
    attempts: item.attempts,
    lastError: item.lastError,
    publishedAt: item.publishedAt,
    url: item.urn && !item.urn.includes("dryrun") ? postUrl(item.urn) : null,
  };
}
