import fs from "node:fs/promises";
import sharp from "sharp";
import { db, now, type MediaKind, type MediaRow } from "../db.js";
import { extractFrame, probe } from "./ffmpeg.js";
import { transcribe } from "./transcribe.js";

export const ACCEPTED_MIME = /^(image\/(jpeg|png|gif|webp|avif)|audio\/.+|video\/.+)$/;

export function kindFromMime(mime: string): MediaKind | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return null;
}

/** Claude's vision input is most efficient at or below ~1.15 megapixels; 1568px is the documented long-edge sweet spot. */
const AI_IMAGE_MAX = 1568;

export function getMedia(userId: number, id: number): MediaRow | undefined {
  return db().prepare("SELECT * FROM media WHERE id = ? AND user_id = ?").get(id, userId) as MediaRow | undefined;
}

export function getMediaMany(userId: number, ids: number[]): MediaRow[] {
  const rows = ids.map((id) => getMedia(userId, id));
  const missing = ids.filter((_, i) => !rows[i]);
  if (missing.length) throw new Error(`Media not found: ${missing.join(", ")}`);
  return rows as MediaRow[];
}

export function listMedia(userId: number): MediaRow[] {
  return db().prepare("SELECT * FROM media WHERE user_id = ? ORDER BY created_at DESC").all(userId) as MediaRow[];
}

export function insertMedia(
  userId: number,
  file: { originalname: string; mimetype: string; size: number; path: string },
  kind: MediaKind,
): MediaRow {
  const result = db()
    .prepare(
      `INSERT INTO media (user_id, kind, original_name, mime, size, path, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)`,
    )
    .run(userId, kind, file.originalname, file.mimetype, file.size, file.path, now());
  return getMedia(userId, Number(result.lastInsertRowid))!;
}

function update(id: number, fields: Partial<MediaRow>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db()
    .prepare(`UPDATE media SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`)
    .run({ ...fields, id });
}

export function updateMediaDetails(userId: number, id: number, fields: { transcript?: string; alt_text?: string }): void {
  if (!getMedia(userId, id)) throw new Error("Media not found");
  update(id, fields);
}

async function processImage(m: MediaRow): Promise<Partial<MediaRow>> {
  const previewPath = `${m.path}.preview.jpg`;
  const info = await sharp(m.path)
    .rotate()
    .resize({ width: AI_IMAGE_MAX, height: AI_IMAGE_MAX, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(previewPath);
  const meta = await sharp(m.path).metadata();
  return { preview_path: previewPath, width: meta.width ?? info.width, height: meta.height ?? info.height };
}

function frameTimes(duration: number): number[] {
  const count = duration < 10 ? 3 : duration < 60 ? 5 : 8;
  return Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * duration);
}

async function processVideo(m: MediaRow): Promise<Partial<MediaRow>> {
  const info = await probe(m.path);
  const duration = info.durationS ?? 1;
  const frames: string[] = [];
  for (const [i, t] of frameTimes(duration).entries()) {
    const out = `${m.path}.frame${i}.jpg`;
    try {
      await extractFrame(m.path, t, out);
      frames.push(out);
    } catch (err) {
      // A seek past the last keyframe can fail on short clips; the other frames are enough.
      if (!frames.length && i === 0) throw err;
    }
  }
  const transcript = info.hasAudio ? await transcribeSafely(m.path) : null;
  return {
    duration_s: info.durationS,
    width: info.width,
    height: info.height,
    frames: JSON.stringify(frames),
    preview_path: frames[0] ?? null,
    ...transcript,
  };
}

async function processAudio(m: MediaRow): Promise<Partial<MediaRow>> {
  const info = await probe(m.path);
  return { duration_s: info.durationS, ...(await transcribeSafely(m.path)) };
}

/** A failed transcription shouldn't fail the upload: the user can type or fix the transcript. */
async function transcribeSafely(file: string): Promise<Partial<Pick<MediaRow, "transcript" | "error">>> {
  try {
    return { transcript: await transcribe(file) };
  } catch (err) {
    console.warn("Transcription failed", err);
    return { transcript: "", error: `Transcription failed: ${(err as Error).message}. You can type the transcript yourself.` };
  }
}

export async function processMedia(m: MediaRow): Promise<void> {
  try {
    const fields =
      m.kind === "image" ? await processImage(m) : m.kind === "video" ? await processVideo(m) : await processAudio(m);
    update(m.id, { ...fields, status: "ready" });
  } catch (err) {
    console.error(`Processing media ${m.id} failed`, err);
    update(m.id, { status: "failed", error: (err as Error).message });
  }
}

export async function deleteMedia(userId: number, id: number): Promise<void> {
  const m = getMedia(userId, id);
  if (!m) return;
  db().prepare("DELETE FROM media WHERE id = ?").run(id);
  const files = [m.path, m.preview_path, ...(m.frames ? (JSON.parse(m.frames) as string[]) : [])].filter(Boolean) as string[];
  await Promise.all([...new Set(files)].map((f) => fs.rm(f, { force: true })));
}

/** What the browser sees: no filesystem paths. */
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
    hasPreview: Boolean(m.preview_path),
    createdAt: m.created_at,
  };
}
