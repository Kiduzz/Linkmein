import { useMemo, useState } from "react";
import { api, type Media, type Post, type SavePostInput } from "../api";
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
}

const QUICK_REFINES = ["Make it shorter", "Stronger hook", "More personal", "More professional", "Simpler words", "End with a question"];

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function quickTimes(): { label: string; at: number }[] {
  const at = (daysAhead: number, hour: number, minute = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };
  // Weekday mornings tend to do well on LinkedIn; skip to Monday from the weekend.
  const next = new Date();
  next.setDate(next.getDate() + 1);
  const toWeekday = next.getDay() === 6 ? 2 : next.getDay() === 0 ? 1 : 0;
  return [
    { label: "Tomorrow 8:30", at: at(1 + toWeekday, 8, 30) },
    { label: "Tomorrow 12:00", at: at(1 + toWeekday, 12) },
    { label: "In 3 days 9:00", at: at(3, 9) },
  ];
}

export function PostEditor({ initial, library, postId, source, inspirationId, onSaved }: Props) {
  const [text, setText] = useState(initial.text);
  const [history, setHistory] = useState<string[]>([]);
  const [mediaIds, setMediaIds] = useState(initial.mediaIds);
  const [visibility, setVisibility] = useState(initial.visibility);
  const [scheduledAt, setScheduledAt] = useState<number | null>(initial.scheduledAt);
  const [instruction, setInstruction] = useState("");
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

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between">
            <label className="label" htmlFor="post-text">
              Post
            </label>
            <span className={`text-xs ${tooLong ? "font-medium text-red-600" : "text-slate-500"}`}>
              {text.length.toLocaleString()} / {LINKEDIN_POST_LIMIT.toLocaleString()}
            </span>
          </div>
          <textarea id="post-text" className="input min-h-[320px] font-[inherit] leading-relaxed" value={text} onChange={(e) => setText(e.target.value)} />
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
            {QUICK_REFINES.map((q) => (
              <button key={q} className="btn-secondary px-3 py-1 text-xs" disabled={refine.busy || !text.trim()} onClick={() => runRefine(q)}>
                {q}
              </button>
            ))}
          </div>
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
              <button key={q.label} className="btn-ghost px-2 py-1 text-xs" onClick={() => setScheduledAt(q.at)}>
                {q.label}
              </button>
            ))}
          </div>
          <ErrorText error={save.error} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button className="btn-secondary" disabled={save.busy || blocked} onClick={() => submit("draft")}>
              Save draft
            </button>
            <button className="btn-secondary" disabled={save.busy || blocked || !scheduledAt} onClick={() => submit("schedule")}>
              {scheduledAt ? `Schedule for ${formatWhen(scheduledAt)}` : "Schedule"}
            </button>
            <button className="btn-primary" disabled={save.busy || blocked} onClick={() => submit("publish")}>
              {save.busy ? <Spinner /> : null} Post now
            </button>
          </div>
        </div>
      </div>

      <div className="lg:sticky lg:top-20 lg:self-start">
        <span className="label">Preview</span>
        <LinkedInPreview text={text} media={attached} />
      </div>
    </div>
  );
}
