import { useState } from "react";
import { api, mediaUrl, previewUrl, type Media } from "../api";
import { useApp } from "../context";
import { useMediaLibrary } from "../hooks";
import { MediaTray } from "../components/MediaTray";
import { formatDuration, PageHeader, Spinner, StatusChip } from "../components/ui";
import { describeJob, resumeTranscription, useTranscriptionJobs } from "../media/transcriber";

export function LibraryPage() {
  const { config } = useApp();
  const { media, loaded, refresh } = useMediaLibrary();
  const [justAdded, setJustAdded] = useState<number[]>([]);
  const usedMb = media.reduce((sum, m) => sum + m.size, 0) / 1024 / 1024;

  return (
    <div className="space-y-6">
      <PageHeader title="Library" subtitle="Everything you've uploaded. Fix transcripts and alt text here; Claude uses them when writing.">
        {media.length > 0 && (
          <span className="text-sm text-slate-500" title={config.storage === "blob" ? "Vercel Blob's free plan includes 1 GB of storage" : undefined}>
            {usedMb < 1 ? "<1" : usedMb.toFixed(0)} MB used{config.storage === "blob" ? " of 1 GB free" : ""}
          </span>
        )}
      </PageHeader>
      <MediaTray library={[]} refresh={refresh} selected={justAdded} onChange={setJustAdded} label="Add media" />
      {loaded && !media.length && <p className="text-sm text-slate-500">Nothing here yet.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {media.map((m) => (
          <MediaCard key={`${m.id}:${m.status}:${m.transcript ?? ""}`} m={m} onChanged={refresh} />
        ))}
      </div>
    </div>
  );
}

function MediaCard({ m, onChanged }: { m: Media; onChanged: () => Promise<void> }) {
  const [transcript, setTranscript] = useState(m.transcript ?? "");
  const [altText, setAltText] = useState(m.altText ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = useTranscriptionJobs().get(m.id);
  const dirty = transcript !== (m.transcript ?? "") || altText !== (m.altText ?? "");
  const hasSpeech = m.kind !== "image";

  const save = async () => {
    setSaving(true);
    await api.updateMedia(m.id, {
      transcript: hasSpeech ? transcript : undefined,
      altText: m.kind === "audio" ? undefined : altText,
      // Typing a transcript by hand finishes a pending one.
      ...(m.status === "processing" && transcript.trim() ? { status: "ready" as const, error: null } : {}),
    });
    await onChanged();
    setSaving(false);
  };

  const skip = async () => {
    await api.updateMedia(m.id, { status: "ready", error: null });
    await onChanged();
  };

  const retranscribe = () => {
    setError(null);
    resumeTranscription(m).catch((err) => setError((err as Error).message));
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${m.name}"?`)) return;
    await api.deleteMedia(m.id);
    await onChanged();
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex aspect-video items-center justify-center bg-slate-100">
        {m.kind === "image" && m.hasPreview ? (
          <img src={previewUrl(m.id)} alt={m.altText ?? ""} className="h-full w-full object-cover" />
        ) : m.kind === "video" ? (
          <video src={mediaUrl(m.id)} poster={m.hasPreview ? previewUrl(m.id) : undefined} controls preload="none" className="h-full w-full bg-black" />
        ) : m.kind === "audio" ? (
          <audio src={mediaUrl(m.id)} controls preload="none" className="w-11/12" />
        ) : null}
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium" title={m.name}>
            {m.name}
          </span>
          {m.status !== "ready" && <StatusChip status={m.status === "processing" ? "transcribing" : m.status} />}
        </div>
        <div className="text-xs text-slate-500">
          {m.kind} · {(m.size / 1024 / 1024).toFixed(1)} MB{m.durationS ? ` · ${formatDuration(m.durationS)}` : ""}
          {m.width ? ` · ${m.width}×${m.height}` : ""}
        </div>
        {m.error && <p className="text-xs text-amber-700">{m.error}</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}

        {hasSpeech && m.status === "processing" && (
          <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {job ? (
              <>
                <Spinner /> {describeJob(job)}
              </>
            ) : (
              <>
                <span className="flex-1">Transcription was interrupted.</span>
                <button className="btn-secondary px-2 py-1 text-xs" onClick={retranscribe}>
                  Resume
                </button>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={skip}>
                  Skip
                </button>
              </>
            )}
          </div>
        )}

        {hasSpeech && (
          <div>
            <div className="flex items-center justify-between">
              <label className="label text-xs">Transcript</label>
              {m.status === "ready" && !job && (
                <button className="btn-ghost px-2 py-0.5 text-xs" onClick={retranscribe}>
                  Transcribe again
                </button>
              )}
            </div>
            <textarea className="input min-h-[90px] text-xs" value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="What's said in the recording" />
          </div>
        )}
        {m.kind !== "audio" && (
          <div>
            <label className="label text-xs">Alt text</label>
            <input className="input text-xs" value={altText} onChange={(e) => setAltText(e.target.value)} placeholder="Describe it for screen readers" />
          </div>
        )}
        <div className="flex justify-between">
          <button className="btn-danger px-2 py-1 text-xs" onClick={remove}>
            Delete
          </button>
          {dirty && (
            <button className="btn-primary px-3 py-1 text-xs" disabled={saving} onClick={save}>
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
