import { previewUrl, type Media } from "../api";
import { formatDuration, Spinner } from "./ui";

export function MediaThumb({ m, size = 96, selected, onClick }: { m: Media; size?: number; selected?: boolean; onClick?: () => void }) {
  const ring = selected ? "ring-2 ring-brand-600 ring-offset-2" : "";
  return (
    <button
      type="button"
      onClick={onClick}
      title={m.name}
      className={`relative shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 ${ring} ${onClick ? "cursor-pointer" : "cursor-default"}`}
      style={{ width: size, height: size }}
    >
      {m.hasPreview ? (
        <img src={previewUrl(m.id)} alt={m.altText ?? ""} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-1 text-slate-500">
          <span className="text-2xl">{m.kind === "audio" ? "🎙️" : m.kind === "video" ? "🎬" : "🖼️"}</span>
          <span className="line-clamp-2 text-center text-[10px] leading-tight">{m.name}</span>
        </div>
      )}
      {m.kind === "video" && <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] text-white">▶ {formatDuration(m.durationS)}</span>}
      {m.kind === "audio" && m.durationS !== null && (
        <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] text-white">{formatDuration(m.durationS)}</span>
      )}
      {m.status === "processing" && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-brand-700">
          <Spinner />
        </div>
      )}
      {m.status === "failed" && <div className="absolute inset-0 flex items-center justify-center bg-red-50/90 text-xs text-red-700">Failed</div>}
      {selected && <span className="absolute right-1 top-1 rounded-full bg-brand-600 px-1.5 text-xs text-white">✓</span>}
    </button>
  );
}
