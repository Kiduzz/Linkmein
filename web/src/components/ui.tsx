import { useEffect } from "react";

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // Keep the page behind from scrolling while the modal is open.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 md:p-4" onMouseDown={onClose}>
      {/* Full screen on phones, a centered card on larger screens. */}
      <div
        className={`min-h-full w-full bg-white md:my-8 md:min-h-0 md:rounded-xl md:border md:border-slate-200 md:shadow-sm ${wide ? "md:max-w-5xl" : "md:max-w-2xl"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:rounded-t-xl">
          <h2 className="font-semibold">{title}</h2>
          <button className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-4 md:p-5">{children}</div>
      </div>
    </div>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />;
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  scheduled: "bg-brand-50 text-brand-700",
  publishing: "bg-amber-100 text-amber-800",
  published: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-700",
  processing: "bg-amber-100 text-amber-800",
  transcribing: "bg-amber-100 text-amber-800",
  ready: "bg-emerald-100 text-emerald-800",
};

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip ${STATUS_STYLES[status] ?? "bg-slate-100"}`}>{status}</span>;
}

export function formatDuration(s: number | null) {
  if (s === null) return "";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function formatWhen(ms: number) {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
