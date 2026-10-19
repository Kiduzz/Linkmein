import { useSyncExternalStore } from "react";
import { api, mediaUrl, type Media } from "../api";

// A queue of browser-side transcriptions that survives page navigation. Each
// finished transcript is saved to the server; until then the media is "processing".

export type JobState = { stage: "queued" | "decoding" | "model" | "transcribing"; modelProgress?: number };

const jobs = new Map<number, JobState>();
const pending: { id: number; source: Blob }[] = [];
const listeners = new Set<() => void>();
let snapshot = new Map(jobs);
let running = false;
let worker: Worker | null = null;
const onDone = new Set<(m: Media) => void>();

function emit() {
  snapshot = new Map(jobs);
  listeners.forEach((l) => l());
}

function set(id: number, state: JobState | null) {
  if (state) jobs.set(id, state);
  else jobs.delete(id);
  emit();
}

/** Decodes any audio or video file the browser can play into 16 kHz mono samples, what Whisper expects. */
async function decode(source: Blob): Promise<Float32Array> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await source.arrayBuffer());
  } finally {
    void ctx.close();
  }
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16_000)), 16_000);
  const node = offline.createBufferSource();
  node.buffer = decoded;
  node.connect(offline.destination);
  node.start();
  return (await offline.startRendering()).getChannelData(0);
}

function runWorker(id: number, audio: Float32Array): Promise<string> {
  worker ??= new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  const w = worker;
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      const msg = e.data as { type: string; id?: number; text?: string; error?: string; progress?: number };
      if (msg.type === "model-progress") set(id, { stage: "model", modelProgress: msg.progress });
      else if (msg.id !== id) return;
      else if (msg.type === "started") set(id, { stage: "transcribing" });
      else {
        w.removeEventListener("message", handler);
        if (msg.type === "done") resolve(msg.text ?? "");
        else reject(new Error(msg.error ?? "Transcription failed"));
      }
    };
    w.addEventListener("message", handler);
    w.postMessage({ id, audio }, [audio.buffer]);
  });
}

async function next() {
  if (running) return;
  const job = pending.shift();
  if (!job) return;
  running = true;
  try {
    set(job.id, { stage: "decoding" });
    let patch: { transcript: string; status: "ready"; error: string | null };
    try {
      const audio = await decode(job.source);
      const text = audio.length < 8_000 ? "" : await runWorker(job.id, audio);
      patch = { transcript: text, status: "ready", error: text ? null : "No speech found. You can type the transcript yourself." };
    } catch (err) {
      const reason = (err as Error).name === "EncodingError" ? "no audio this browser can read in this file" : (err as Error).message;
      patch = { transcript: "", status: "ready", error: `Transcription failed: ${reason}. You can type the transcript yourself.` };
    }
    const media = await api.updateMedia(job.id, patch);
    onDone.forEach((f) => f(media));
  } catch (err) {
    console.error("Saving transcript failed", err);
  } finally {
    set(job.id, null);
    running = false;
    void next();
  }
}

export function transcribe(mediaId: number, source: Blob): void {
  if (jobs.has(mediaId)) return;
  pending.push({ id: mediaId, source });
  set(mediaId, { stage: "queued" });
  void next();
}

/** Picks up a transcription that was interrupted (for example, the tab was closed). */
export async function resumeTranscription(m: Media): Promise<void> {
  if (jobs.has(m.id)) return;
  set(m.id, { stage: "queued" });
  try {
    const res = await fetch(mediaUrl(m.id));
    if (!res.ok) throw new Error(`Couldn't download ${m.name}`);
    jobs.delete(m.id);
    transcribe(m.id, await res.blob());
  } catch (err) {
    set(m.id, null);
    throw err;
  }
}

/** Live map of media id → transcription progress, for showing status in the UI. */
export function useTranscriptionJobs(): Map<number, JobState> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

/** Called with the updated media whenever a transcript is saved. */
export function onTranscribed(f: (m: Media) => void): () => void {
  onDone.add(f);
  return () => onDone.delete(f);
}

export function describeJob(job: JobState): string {
  if (job.stage === "model") return `Downloading speech model ${Math.round(job.modelProgress ?? 0)}%`;
  if (job.stage === "transcribing") return "Transcribing…";
  if (job.stage === "decoding") return "Reading audio…";
  return "Waiting to transcribe…";
}
