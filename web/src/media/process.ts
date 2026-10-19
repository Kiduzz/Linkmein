import { upload as blobUpload } from "@vercel/blob/client";
import { api, type AppConfig, type Media } from "../api";
import { transcribe } from "./transcriber";

// Prepares files in the browser before upload: photos are resized (and stripped of
// location metadata), frames are sampled from videos, and speech is queued for
// transcription. Then everything goes straight to storage and gets registered.

const AI_IMAGE_MAX = 1568; // Claude's vision sweet spot on the long edge
const POST_IMAGE_MAX = 4096; // plenty for LinkedIn, and keeps storage small
const FRAME_MAX = 1024;

type Kind = Media["kind"];

function kindOf(file: File): Kind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  // Some browsers leave type empty for HEIC or voice memos.
  if (/\.(heic|heif)$/i.test(file.name)) return "image";
  if (/\.(m4a|mp3|wav|ogg|opus)$/i.test(file.name)) return "audio";
  if (/\.(mov|mp4|webm|m4v)$/i.test(file.name)) return "video";
  return null;
}

function canvasToJpeg(source: CanvasImageSource, width: number, height: number, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // transparent PNGs shouldn't turn black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode image"))), "image/jpeg", quality));
}

async function prepareImage(file: File) {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`This browser can't read "${file.name}". Try a JPEG or PNG${/heic|heif/i.test(file.type + file.name) ? " (Safari can open iPhone HEIC photos)" : ""}.`);
  }
  // GIFs keep their animation and PNGs their sharpness; everything else becomes a clean JPEG.
  const keep = (file.type === "image/gif" || file.type === "image/png") && Math.max(bitmap.width, bitmap.height) <= POST_IMAGE_MAX;
  const original = keep ? file : await canvasToJpeg(bitmap, bitmap.width, bitmap.height, POST_IMAGE_MAX, 0.9);
  const preview = await canvasToJpeg(bitmap, bitmap.width, bitmap.height, AI_IMAGE_MAX, 0.85);
  const result = { original, preview, width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return result;
}

function waitFor(el: HTMLMediaElement, event: string, ms = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`Timed out waiting for ${event}`)), ms);
    const ok = () => done();
    const fail = () => done(new Error("This browser can't play this video format"));
    function done(err?: Error) {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", fail);
      if (err) reject(err);
      else resolve();
    }
    el.addEventListener(event, ok, { once: true });
    el.addEventListener("error", fail, { once: true });
  });
}

function frameTimes(duration: number): number[] {
  const count = duration < 10 ? 3 : duration < 60 ? 5 : 8;
  return Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * duration);
}

async function prepareVideo(file: File) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await waitFor(video, "loadeddata");
    const durationS = Number.isFinite(video.duration) ? video.duration : undefined;
    const frames: Blob[] = [];
    for (const t of frameTimes(durationS ?? 1)) {
      video.currentTime = t;
      await waitFor(video, "seeked");
      frames.push(await canvasToJpeg(video, video.videoWidth, video.videoHeight, FRAME_MAX, 0.8));
    }
    return { durationS, width: video.videoWidth || undefined, height: video.videoHeight || undefined, frames, error: undefined };
  } catch (err) {
    // Still upload it: LinkedIn may play formats this browser can't (such as HEVC .mov).
    return { durationS: undefined, width: undefined, height: undefined, frames: [] as Blob[], error: `Couldn't preview this video here: ${(err as Error).message}.` };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function audioDuration(file: File): Promise<number | undefined> {
  const url = URL.createObjectURL(file);
  const audio = new Audio();
  audio.preload = "metadata";
  audio.src = url;
  try {
    await waitFor(audio, "loadedmetadata", 5_000);
    return Number.isFinite(audio.duration) ? audio.duration : undefined;
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function put(config: AppConfig, key: string, body: Blob): Promise<void> {
  if (config.storage === "blob") {
    await blobUpload(key, body, {
      access: "private",
      handleUploadUrl: "/api/blob/upload",
      headers: { "X-Linkmein": "1" },
      contentType: body.type || "application/octet-stream",
      multipart: body.size > 20 * 1024 * 1024,
    });
    return;
  }
  const res = await fetch(`/api/uploads/${key}`, {
    method: "PUT",
    headers: { "X-Linkmein": "1", "Content-Type": body.type || "application/octet-stream" },
    body,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Upload failed (${res.status})`);
}

function extension(file: Blob, fallback: string): string {
  const fromType = file.type.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg").replace("quicktime", "mov").replace("x-m4a", "m4a");
  return (fromType && /^[a-z0-9]{2,5}$/.test(fromType) ? fromType : fallback).toLowerCase();
}

/** Prepares, uploads and registers one file. Speech transcription continues in the background. */
export async function uploadMedia(file: File, userId: number, config: AppConfig): Promise<Media> {
  const kind = kindOf(file);
  if (!kind) throw new Error(`"${file.name}" isn't a photo, video or audio file.`);
  if (file.size > config.maxUploadMb * 1024 * 1024) throw new Error(`"${file.name}" is over the ${config.maxUploadMb} MB limit.`);
  const dir = `u/${userId}/${crypto.randomUUID()}`;
  const name = file.name.slice(0, 200) || `${kind} upload`;

  if (kind === "image") {
    const img = await prepareImage(file);
    const fileKey = `${dir}/original.${extension(img.original, "jpg")}`;
    await Promise.all([put(config, fileKey, img.original), put(config, `${dir}/preview.jpg`, img.preview)]);
    return api.registerMedia({ kind, name, mime: img.original.type, fileKey, previewKey: `${dir}/preview.jpg`, width: img.width, height: img.height, status: "ready" });
  }

  const mime = file.type || (kind === "video" ? "video/mp4" : "audio/mp4");
  const fileKey = `${dir}/original.${extension(file, kind === "video" ? "mp4" : "m4a")}`;

  if (kind === "video") {
    const v = await prepareVideo(file);
    const frameKeys = v.frames.map((_, i) => `${dir}/frame-${i}.jpg`);
    await Promise.all([put(config, fileKey, file), ...v.frames.map((f, i) => put(config, frameKeys[i], f))]);
    const media = await api.registerMedia({
      kind,
      name,
      mime,
      fileKey,
      frameKeys,
      previewKey: frameKeys[0],
      durationS: v.durationS,
      width: v.width,
      height: v.height,
      status: "processing",
      error: v.error,
    });
    transcribe(media.id, file);
    return media;
  }

  const durationS = await audioDuration(file);
  await put(config, fileKey, file);
  const media = await api.registerMedia({ kind, name, mime, fileKey, durationS, status: "processing" });
  transcribe(media.id, file);
  return media;
}

/** Uploads several files one by one, collecting successes and the first error. */
export async function uploadMany(files: File[], userId: number, config: AppConfig): Promise<{ media: Media[]; error: string | null }> {
  const media: Media[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      media.push(await uploadMedia(f, userId, config));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { media, error: errors.length ? errors.join(" ") : null };
}
