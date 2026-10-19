import path from "node:path";
import { config } from "../config.js";
import { decodePcm16k } from "./ffmpeg.js";

// Speech-to-text runs locally with Whisper via transformers.js, so voice notes never
// leave your server and you don't need a second API key. The model (~150 MB for
// whisper-base) downloads into DATA_DIR/models on first use.

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

let loading: Promise<Transcriber> | null = null;

async function loadTranscriber(): Promise<Transcriber> {
  // Optional dependency: keep the import dynamic so the app runs without it.
  const moduleName = "@huggingface/transformers";
  let transformers: any;
  try {
    transformers = await import(moduleName);
  } catch {
    throw new Error("Local transcription is unavailable: install the optional @huggingface/transformers package.");
  }
  transformers.env.cacheDir = path.join(config.dataDir, "models");
  return (await transformers.pipeline("automatic-speech-recognition", config.whisperModel)) as Transcriber;
}

function transcriber(): Promise<Transcriber> {
  if (!loading) {
    loading = loadTranscriber();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

// Whisper is memory-hungry; run one job at a time.
let queue: Promise<unknown> = Promise.resolve();

export function transcribe(file: string): Promise<string> {
  const job = queue.then(async () => {
    const audio = await decodePcm16k(file);
    if (audio.length < 16_000 / 2) return ""; // under half a second
    const asr = await transcriber();
    const result = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, task: "transcribe" });
    const text = Array.isArray(result) ? result.map((r) => r.text).join(" ") : result.text;
    return text.trim();
  });
  queue = job.catch(() => undefined);
  return job;
}
