import { useRef, useState } from "react";
import { api, type Media } from "../api";
import { MediaThumb } from "./MediaThumb";
import { VoiceRecorder } from "./VoiceRecorder";
import { ErrorText, Modal, Spinner } from "./ui";

interface Props {
  library: Media[];
  refresh: () => Promise<void>;
  selected: number[];
  onChange: (ids: number[]) => void;
  label?: string;
}

/** Pick the material Claude should write from: upload, record, or choose from the library. */
export function MediaTray({ library, refresh, selected, onChange, label = "Material" }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);

  const byId = new Map(library.map((m) => [m.id, m]));
  const chosen = selected.map((id) => byId.get(id)).filter(Boolean) as Media[];

  const added = async (media: Media[]) => {
    onChange([...selected, ...media.map((m) => m.id)]);
    await refresh();
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      await added(await api.upload(files));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div>
      <span className="label">{label}</span>
      <div
        className={`rounded-xl border-2 border-dashed p-4 transition ${dragging ? "border-brand-500 bg-brand-50" : "border-slate-300 bg-white"}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
      >
        {chosen.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-3">
            {chosen.map((m) => (
              <div key={m.id} className="relative">
                <MediaThumb m={m} size={88} />
                <button
                  type="button"
                  onClick={() => toggle(m.id)}
                  className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-xs shadow hover:bg-slate-100"
                  aria-label={`Remove ${m.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary" onClick={() => input.current?.click()} disabled={uploading}>
            {uploading ? <Spinner /> : "⬆️"} Upload photos, video or audio
          </button>
          <VoiceRecorder onUploaded={added} />
          {library.length > 0 && (
            <button type="button" className="btn-ghost" onClick={() => setPicking(true)}>
              Choose from library
            </button>
          )}
          <span className="text-xs text-slate-500">or drop files here</span>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/gif,image/webp,image/avif,video/*,audio/*"
          className="hidden"
          onChange={(e) => {
            void upload(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        {chosen.some((m) => m.status === "processing") && (
          <p className="mt-3 text-xs text-slate-500">Processing… videos and voice notes are transcribed on your server, which can take a minute.</p>
        )}
        <div className="mt-2">
          <ErrorText error={error} />
        </div>
      </div>

      {picking && (
        <Modal title="Your media library" onClose={() => setPicking(false)} wide>
          <div className="flex flex-wrap gap-3">
            {library.map((m) => (
              <MediaThumb key={m.id} m={m} size={110} selected={selected.includes(m.id)} onClick={() => toggle(m.id)} />
            ))}
          </div>
          <div className="mt-4 text-right">
            <button className="btn-primary" onClick={() => setPicking(false)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
