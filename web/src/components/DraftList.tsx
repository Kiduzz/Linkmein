import type { PostDraft } from "../../../shared/types";

export function DraftList<T extends PostDraft & { overlap?: number }>({ drafts, onPick }: { drafts: T[]; onPick: (d: T) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {drafts.map((d, i) => (
        <div key={i} className="card flex flex-col p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="chip bg-brand-50 text-brand-700">{d.angle}</span>
            {d.overlap !== undefined && <OverlapBadge overlap={d.overlap} />}
          </div>
          <p className="line-clamp-[12] flex-1 whitespace-pre-wrap text-sm leading-relaxed">{d.text}</p>
          <p className="mt-3 text-xs italic text-slate-500">{d.rationale}</p>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-slate-400">{d.text.length} chars</span>
            <button className="btn-primary py-1.5" onClick={() => onPick(d)}>
              Use this
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function OverlapBadge({ overlap }: { overlap: number }) {
  const pct = Math.round(overlap * 100);
  const style = overlap > 0.12 ? "bg-red-100 text-red-700" : overlap > 0.05 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800";
  return (
    <span className={`chip ${style}`} title="Share of 5-word phrases that also appear in the original post">
      {pct === 0 ? "Fully original wording" : `${pct}% phrase overlap`}
    </span>
  );
}
