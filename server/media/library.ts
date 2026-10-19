import { all, get, now, run, type MediaKind, type MediaRow, type MediaStatus } from "../db.js";
import { deleteFiles, ownsKey, sizeOf } from "../storage.js";
import { config } from "../config.js";

// Photos are resized, video frames sampled and speech transcribed in the browser
// before upload, so the server only records what arrived and checks it's legit.

/** What LinkedIn can display. The browser converts other image formats to JPEG first. */
export const IMAGE_MIME = /^image\/(jpeg|png|gif)$/;

export class MediaError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function getMedia(userId: number, id: number): Promise<MediaRow | undefined> {
  return get<MediaRow>("SELECT * FROM media WHERE id = ? AND user_id = ?", [id, userId]);
}

export async function getMediaMany(userId: number, ids: number[]): Promise<MediaRow[]> {
  const rows = await Promise.all(ids.map((id) => getMedia(userId, id)));
  const missing = ids.filter((_, i) => !rows[i]);
  if (missing.length) throw new MediaError(`Media not found: ${missing.join(", ")}`);
  return rows as MediaRow[];
}

export function listMedia(userId: number): Promise<MediaRow[]> {
  return all<MediaRow>("SELECT * FROM media WHERE user_id = ? ORDER BY created_at DESC", [userId]);
}

export interface NewMedia {
  kind: MediaKind;
  name: string;
  mime: string;
  fileKey: string;
  previewKey?: string;
  frameKeys?: string[];
  durationS?: number;
  width?: number;
  height?: number;
  transcript?: string;
  /** "processing" while the browser is still transcribing. */
  status: MediaStatus;
  error?: string;
}

export async function registerMedia(userId: number, m: NewMedia): Promise<MediaRow> {
  const keys = [m.fileKey, m.previewKey, ...(m.frameKeys ?? [])].filter(Boolean) as string[];
  if (!keys.every((k) => ownsKey(userId, k))) throw new MediaError("Invalid upload key.", 403);
  if (!m.mime.startsWith(`${m.kind}/`)) throw new MediaError(`A ${m.kind} can't have type ${m.mime}.`);
  if (m.kind === "image" && !IMAGE_MIME.test(m.mime)) throw new MediaError("Images must be JPEG, PNG or GIF.");

  // Trust the stored bytes, not the browser, for size and existence.
  const size = await sizeOf(m.fileKey);
  if (size === null) throw new MediaError("The upload didn't arrive. Please try again.");
  if (size > config.maxUploadMb * 1024 * 1024) {
    await deleteFiles(keys);
    throw new MediaError(`Files are limited to ${config.maxUploadMb} MB.`);
  }

  const result = await run(
    `INSERT INTO media (user_id, kind, original_name, mime, size, file_key, status, error, transcript, frame_keys, preview_key, duration_s, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      m.kind,
      m.name,
      m.mime,
      size,
      m.fileKey,
      m.status,
      m.error ?? null,
      m.transcript ?? null,
      m.frameKeys?.length ? JSON.stringify(m.frameKeys) : null,
      m.previewKey ?? null,
      m.durationS ?? null,
      m.width ?? null,
      m.height ?? null,
      now(),
    ],
  );
  return (await getMedia(userId, result.lastId))!;
}

export async function updateMediaDetails(
  userId: number,
  id: number,
  fields: { transcript?: string; alt_text?: string; status?: MediaStatus; error?: string | null },
): Promise<void> {
  if (!(await getMedia(userId, id))) throw new MediaError("Media not found", 404);
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  await run(`UPDATE media SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ? AND user_id = ?`, [
    ...entries.map(([, v]) => v as string | null),
    id,
    userId,
  ]);
}

export function mediaKeys(m: MediaRow): string[] {
  return [m.file_key, m.preview_key, ...(m.frame_keys ? (JSON.parse(m.frame_keys) as string[]) : [])].filter(Boolean) as string[];
}

export async function deleteMedia(userId: number, id: number): Promise<void> {
  const m = await getMedia(userId, id);
  if (!m) return;
  await run("DELETE FROM media WHERE id = ?", [id]);
  await deleteFiles(mediaKeys(m));
}

/** What the browser sees: no storage keys. */
export function publicMedia(m: MediaRow) {
  return {
    id: m.id,
    kind: m.kind,
    name: m.original_name,
    mime: m.mime,
    size: m.size,
    status: m.status,
    error: m.error,
    transcript: m.transcript,
    altText: m.alt_text,
    durationS: m.duration_s,
    width: m.width,
    height: m.height,
    hasPreview: Boolean(m.preview_key),
    createdAt: m.created_at,
  };
}
