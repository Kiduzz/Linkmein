import { useMemo, useState } from "react";
import { api, type Media, type Post, type SavePostInput } from "../api";
import { replaceOpening, type HookReview } from "../ai/generate";
import { useAction } from "../hooks";
import { LINKEDIN_POST_LIMIT } from "../../../shared/types";
import { LinkedInPreview } from "./LinkedInPreview";
import { MediaThumb } from "./MediaThumb";
import { ErrorText, formatWhen, Spinner } from "./ui";

export interface EditorValue {
  text: string;
  mediaIds: number[];
  visibility: "PUBLIC" | "CONNECTIONS";
  scheduledAt: number | null;
}

interface Props {
  initial: EditorValue;
  /** Media the user can attach to the post (audio is filtered out). */
  library: Media[];
  postId?: number;
  source?: string;
  inspirationId?: number;
  onSaved: (post: Post) => void;
  /** Inside a full-screen modal there's no bottom tab bar to sit above. */
  inModal?: boolean;
}

const QUICK_REFINES = ["Make it shorter", "Stronger hook", "More personal", "More professional", "Simpler words", "End with a question"];

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Next weekday at the given time (weekday mornings and lunchtimes tend to do well on LinkedIn). */
function nextWeekday(daysAhead: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function quickTimes(): { label: string; at: number }[] {
  const label = (d: Date) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const day = d.toDateString() === tomorrow.toDateString() ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short" });
    return `${day} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  };
  return [nextWeekday(1, 8, 30), nextWeekday(1, 12), nextWeekday(3, 9)].map((d) => ({ label: label(d), at: d.getTime() }));
}

export function PostEditor({ initial, library, postId, source, inspirationId, onSaved, inModal }: Props) {
  const [text, setText] = useState(initial.text);
  const [history, setHistory] = useState<string[]>([]);
  const [mediaIds, setMediaIds] = useState(initial.mediaIds);
  const [visibility, setVisibility] = useState(initial.visibility);
  const [scheduledAt, setScheduledAt] = useState<number | null>(initial.scheduledAt);
  const [instruction, setInstruction] = useState("");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [hook, setHook] = useState<HookReview | null>(null);
  const refine = useAction();
  const save = useAction();

  const attachable = useMemo(() => library.filter((m) => m.kind !== "audio" && m.status === "ready"), [library]);
  const attached = mediaIds.map((id) => attachable.find((m) => m.id === id)).filter(Boolean) as Media[];
  const hasVideo = attached.some((m) => m.kind === "video");
  const mediaProblem = hasVideo && attached.length > 1 ? "LinkedIn allows one video, or up to 20 images, but not both." : attached.length > 20 ? "LinkedIn allows at most 20 images." : null;
  const tooLong = text.length > LINKEDIN_POST_LIMIT;

  const runRefine = (how: string) =>
    refine.run(async () => {
      const res = await api.refine(text, how);
      setHistory((h) => [...h, text]);
      setText(res.text);
      setInstruction("");
    });

  const runHookCheck = () =>
    refine.run(async () => {
      setHook(await api.checkHook(text));
    });

  const useOpening = (opening: string) => {
    setHistory((h) => [...h, text]);
    setText(replaceOpening(text, opening));
    setHook(null);
  };

  const undo = () => {
    const prev = history.at(-1);
    if (prev === undefined) return;
    setText(prev);
    setHistory((h) => h.slice(0, -1));
  };

  const toggleMedia = (id: number) => setMediaIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const submit = (action: SavePostInput["action"]) =>
    save.run(async () => {
      if (action === "publish" && !window.confirm("Publish this post to LinkedIn now?")) return;
      const body: SavePostInput = {
        text,
        mediaIds: attached.map((m) => m.id),
        visibility,
        action,
        ...(action === "schedule" && scheduledAt ? { scheduledAt } : {}),
        ...(source ? { source } : {}),
        ...(inspirationId ? { inspirationId } : {}),
      };
      const post = postId ? await api.updatePost(postId, body) : await api.createPost(body);
      onSaved(post);
    });

  const blocked = tooLong || Boolean(mediaProblem) || (!text.trim() && !attached.length);

  const actions = (
    <>
      <button className="btn-secondary" disabled={save.busy || blocked} onClick={() => submit("draft")}>
        Save draft
      </button>
      <button className="btn-secondary" disabled={save.busy || blocked || !scheduledAt} onClick={() => submit("schedule")}>
        {scheduledAt ? (
          <>
            <span className="hidden sm:inline">Schedule for {formatWhen(scheduledAt)}</span>
            <span className="sm:hidden">Schedule</span>
          </>
        ) : (
          "Schedule"
        )}
      </button>
      <button className="btn-primary" disabled={save.busy || blocked} onClick={() => submit("publish")}>
        {save.busy ? <Spinner /> : null} Post now
      </button>
    </>
  );

  return (
    <div className="pb-20 lg:pb-0">
      {/* Phones show one pane at a time; larger screens show both side by side. */}
      <div className="mb-4 grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm lg:hidden">
        {(["write", "preview"] as const).map((t) => (
          <button key={t} className={`rounded-md py-1.5 ${tab === t ? "bg-white font-medium shadow-sm" : "text-slate-600"}`} onClick={() => setTab(t)}>
            {t === "write" ? "Write" : "Preview"}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
        <div className={`space-y-4 ${tab === "preview" ? "hidden lg:block" : ""}`}>
          <div>
            <div className="flex items-center justify-between">
              <label className="label" htmlFor="post-text">
                Post
              </label>
              <span className={`text-xs ${tooLong ? "font-medium text-red-600" : "text-slate-500"}`}>
                {text.length.toLocaleString()} / {LINKEDIN_POST_LIMIT.toLocaleString()}
              </span>
            </div>
            <textarea id="post-text" className="input min-h-[260px] font-[inherit] leading-relaxed lg:min-h-[320px]" value={text} onChange={(e) => setText(e.target.value)} />
          </div>

          <div className="card space-y-3 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Refine with Claude</span>
              {history.length > 0 && (
                <button className="btn-ghost px-2 py-1 text-xs" onClick={undo} disabled={refine.busy}>
                  ↶ Undo
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary border-brand-100 bg-brand-50 px-3 py-1 text-xs text-brand-700" disabled={refine.busy || !text.trim()} onClick={runHookCheck}>
                🎯 Check my hook
              </button>
              {QUICK_REFINES.map((q) => (
                <button key={q} className="btn-secondary px-3 py-1 text-xs" disabled={refine.busy || !text.trim()} onClick={() => runRefine(q)}>
                  {q}
                </button>
              ))}
            </div>
            {hook && <HookResult review={hook} onUse={useOpening} onClose={() => setHook(null)} />}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (instruction.trim()) void runRefine(instruction);
              }}
            >
              <input className="input" placeholder="Or say what to change, e.g. “mention the team by role, not name”" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
              <button className="btn-secondary" disabled={refine.busy || !instruction.trim() || !text.trim()}>
                {refine.busy ? <Spinner /> : "Apply"}
              </button>
            </form>
            {refine.busy && <p className="text-xs text-slate-500">Claude is working on it…</p>}
            <ErrorText error={refine.error} />
          </div>

          {attachable.length > 0 && (
            <div>
              <span className="label">Attach to the post</span>
              <div className="flex flex-wrap gap-2">
                {attachable.map((m) => (
                  <MediaThumb key={m.id} m={m} size={72} selected={mediaIds.includes(m.id)} onClick={() => toggleMedia(m.id)} />
                ))}
              </div>
              {mediaProblem && <p className="mt-2 text-sm text-red-600">{mediaProblem}</p>}
            </div>
          )}

          <div className="card space-y-4 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="visibility">
                  Who can see it
                </label>
                <select id="visibility" className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as EditorValue["visibility"])}>
                  <option value="PUBLIC">Anyone</option>
                  <option value="CONNECTIONS">Connections only</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="when">
                  Schedule for
                </label>
                <input
                  id="when"
                  type="datetime-local"
                  className="input"
                  value={scheduledAt ? toLocalInput(scheduledAt) : ""}
                  min={toLocalInput(Date.now())}
                  onChange={(e) => setScheduledAt(e.target.value ? new Date(e.target.value).getTime() : null)}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {quickTimes().map((q) => (
                <button key={q.label} className={`btn-ghost px-2 py-1 text-xs ${scheduledAt === q.at ? "bg-brand-50 text-brand-700" : ""}`} onClick={() => setScheduledAt(q.at)}>
                  {q.label}
                </button>
              ))}
            </div>
            <ErrorText error={save.error} />
            <div className="hidden flex-wrap items-center justify-end gap-2 lg:flex">{actions}</div>
          </div>
        </div>

        <div className={`lg:sticky lg:top-20 lg:self-start ${tab === "write" ? "hidden lg:block" : ""}`}>
          <span className="label hidden lg:block">Preview</span>
          <LinkedInPreview text={text} media={attached} />
        </div>
      </div>

      {/* On phones the actions stay pinned at the bottom of the screen. */}
      <div
        className={`fixed inset-x-0 z-40 flex items-center justify-end gap-2 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:hidden ${
          inModal ? "bottom-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]" : "bottom-[calc(3.75rem+env(safe-area-inset-bottom))]"
        }`}
      >
        {save.error && <span className="mr-auto line-clamp-2 text-xs text-red-600">{save.error}</span>}
        {actions}
      </div>
    </div>
  );
}

function HookResult({ review, onUse, onClose }: { review: HookReview; onUse: (opening: string) => void; onClose: () => void }) {
  const tone = review.score >= 8 ? "bg-emerald-100 text-emerald-800" : review.score >= 5 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700";
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`chip text-sm ${tone}`}>{review.score}/10</span>
          <span className="text-sm font-medium">Your opening</span>
        </div>
        <button className="btn-ghost px-2 py-0.5 text-xs" onClick={onClose} aria-label="Close hook check">
          ✕
        </button>
      </div>
      <p className="text-sm text-slate-700">{review.verdict}</p>
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Stronger openings</p>
        {review.alternatives.map((alt, i) => (
          <div key={i} className="flex items-start gap-2 rounded-lg bg-white p-2.5">
            <p className="flex-1 whitespace-pre-wrap text-sm">{alt}</p>
            <button className="btn-secondary shrink-0 px-2 py-1 text-xs" onClick={() => onUse(alt)}>
              Use
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
