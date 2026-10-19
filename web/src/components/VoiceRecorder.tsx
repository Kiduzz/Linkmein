import { useEffect, useRef, useState } from "react";
import type { Media } from "../api";
import { uploadMedia } from "../media/process";

function pickMime(): string {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/** Records a voice note in the browser and uploads it for transcription. */
export function VoiceRecorder({ onUploaded }: { onUploaded: (m: Media[]) => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = (rec.mimeType || mime || "audio/webm").split(";")[0];
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const blob = new Blob(chunks, { type });
        setUploading(true);
        try {
          const file = new File([blob], `Voice note ${new Date().toLocaleString()}.${ext}`, { type });
          onUploaded([await uploadMedia(file)]);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setUploading(false);
        }
      };
      rec.start(1000);
      recorder.current = rec;
      setSeconds(0);
      setRecording(true);
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      setError("Microphone access was blocked. Allow it in your browser to record.");
    }
  };

  const stop = () => {
    recorder.current?.stop();
    recorder.current = null;
    if (timer.current) clearInterval(timer.current);
    setRecording(false);
  };

  return (
    <div className="inline-flex flex-col">
      {recording ? (
        <button type="button" className="btn border border-red-300 bg-red-50 text-red-700 hover:bg-red-100" onClick={stop}>
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" /> Stop · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </button>
      ) : (
        <button type="button" className="btn-secondary" onClick={start} disabled={uploading}>
          🎙️ {uploading ? "Uploading…" : "Record voice note"}
        </button>
      )}
      {error && <span className="mt-1 text-xs text-red-600">{error}</span>}
    </div>
  );
}
