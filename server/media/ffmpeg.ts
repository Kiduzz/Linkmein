import { spawn } from "node:child_process";
import { config } from "../config.js";

function run(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    child.on("error", (e) => reject(new Error(`${bin} could not start (${e.message}). Install ffmpeg or set FFMPEG_PATH/FFPROBE_PATH.`)));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${bin} exited with ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}

export const ffmpeg = (args: string[]) => run(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);

export interface Probe {
  durationS: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
}

export async function probe(file: string): Promise<Probe> {
  const out = await run(config.ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const json = JSON.parse(out.toString()) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
  };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const duration = Number(json.format?.duration ?? video?.duration);
  return {
    durationS: Number.isFinite(duration) ? duration : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    hasVideo: Boolean(video),
  };
}

/** Decodes any audio/video file to mono 16 kHz float PCM, the input Whisper expects. */
export async function decodePcm16k(file: string): Promise<Float32Array> {
  const raw = await ffmpeg(["-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"]);
  // Copy so the Float32Array is 4-byte aligned regardless of Buffer pooling.
  return new Float32Array(new Uint8Array(raw).buffer);
}

export async function extractFrame(file: string, atSeconds: number, outFile: string, maxWidth = 1024): Promise<void> {
  await ffmpeg([
    "-ss", atSeconds.toFixed(2),
    "-i", file,
    "-frames:v", "1",
    "-vf", `scale='min(${maxWidth},iw)':-2`,
    "-q:v", "3",
    outFile,
  ]);
}
