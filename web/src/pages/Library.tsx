import { useState } from "react";
import { api, mediaUrl, previewUrl, type Media } from "../api";
import { useMediaLibrary } from "../hooks";
import { MediaTray } from "../components/MediaTray";
import { formatDuration, PageHeader, Spinner, StatusChip } from "../components/ui";

export function LibraryPage() {
  const { media, loaded, refresh } = useMediaLibrary();
  const [justAdded, setJustAdded] = useState<number[]>([]);

  return (
    <div className="space-y-6">
      <PageHeader title="Library" subtitle="Everything you've uploaded. Fix transcripts and alt text here; Claude uses them when writing." />
      <MediaTray library={[]} refresh={refresh} selected={justAdded} onChange={setJustAdded} label="Add media" />
      {loaded && !media.length && <p className="text-sm text-slate-500">Nothing here yet.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {media.map((m) => (
          <MediaCard key={`${m.id}:${m.status}`} m={m} onChanged={refresh} />
        ))}
      </div>
    </div>
  );
}

function MediaCard({ m, onChanged }: { m: Media; onChanged: () => Promise<void> }) {
  const [transcript, setTranscript] = useState(m.transcript ?? "");
  const [altText, setAltText] = useState(m.altText ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = transcript !== (m.transcript ?? "") || altText !== (m.altText ?? "");

  const save = async () => {
    setSaving(true);
    await api.updateMedia(m.id, { transcript: m.kind === "image" ? undefined : transcript, altText: m.kind === "audio" ? undefined : altText });
    await onChanged();
    setSaving(false);
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${m.name}"?`)) return;
    await api.deleteMedia(m.id);
    await onChanged();
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex aspect-video items-center justify-center bg-slate-100">
        {m.status === "processing" ? (
          <span className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Processing…
          </span>
        ) : m.kind === "image" && m.hasPreview ? (
          <img src={previewUrl(m.id)} alt={m.altText ?? ""} className="h-full w-full object-cover" />
        ) : m.kind === "video" ? (
          <video src={mediaUrl(m.id)} poster={m.hasPreview ? previewUrl(m.id) : undefined} controls className="h-full w-full bg-black" />
        ) : m.kind === "audio" ? (
          <audio src={mediaUrl(m.id)} controls className="w-11/12" />
        ) : null}
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium" title={m.name}>
            {m.name}
          </span>
          <StatusChip status={m.status} />
        </div>
        <div className="text-xs text-slate-500">
          {m.kind} · {(m.size / 1024 / 1024).toFixed(1)} MB{m.durationS ? ` · ${formatDuration(m.durationS)}` : ""}
          {m.width ? ` · ${m.width}×${m.height}` : ""}
        </div>
        {m.error && <p className="text-xs text-amber-700">{m.error}</p>}
        {m.kind !== "image" && m.status !== "processing" && (
          <div>
            <label className="label text-xs">Transcript</label>
            <textarea className="input min-h-[90px] text-xs" value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="What's said in the recording" />
          </div>
        )}
        {m.kind !== "audio" && m.status !== "processing" && (
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
