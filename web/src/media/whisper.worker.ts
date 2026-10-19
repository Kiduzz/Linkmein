// Runs Whisper speech-to-text in the browser with transformers.js, so voice notes
// are transcribed on the user's own device. The model downloads once and is cached.
import { pipeline } from "@huggingface/transformers";

const MODEL = "onnx-community/whisper-base";

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let loading: Promise<Transcriber> | null = null;

function load(): Promise<Transcriber> {
  loading ??= (pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<Transcriber>)(
    "automatic-speech-recognition",
    MODEL,
    {
      progress_callback: (p: { status: string; progress?: number; file?: string }) => {
        if (p.status === "progress" && p.file?.endsWith(".onnx")) self.postMessage({ type: "model-progress", progress: p.progress ?? 0 });
      },
    },
  ).catch((err: Error) => {
    loading = null;
    throw new Error(`couldn't download the speech model (${err.message})`);
  });
  return loading;
}

self.onmessage = async (e: MessageEvent<{ id: number; audio: Float32Array }>) => {
  const { id, audio } = e.data;
  try {
    const asr = await load();
    self.postMessage({ type: "started", id });
    const result = await asr(audio, { chunk_length_s: 30, stride_length_s: 5 });
    const text = Array.isArray(result) ? result.map((r) => r.text).join(" ") : result.text;
    self.postMessage({ type: "done", id, text: text.trim() });
  } catch (err) {
    self.postMessage({ type: "error", id, error: (err as Error).message });
  }
};
