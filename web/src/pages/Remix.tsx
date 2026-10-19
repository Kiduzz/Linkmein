import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, previewUrl, type Inspiration, type Post } from "../api";
import { takeSharedPost, type SharedPost } from "../share";
import { uploadMedia } from "../media/process";
import { useAction, useMediaLibrary } from "../hooks";
import { useApp } from "../context";
import { MediaTray } from "../components/MediaTray";
import { DraftList } from "../components/DraftList";
import { PostEditor, type EditorValue } from "../components/PostEditor";
import { SavedNotice } from "../components/SavedNotice";
import { ErrorText, PageHeader, Spinner } from "../components/ui";
import type { PostLength, RemixDraft } from "../../../shared/types";

export function RemixPage() {
  const [items, setItems] = useState<Inspiration[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState<Post | null>(null);
  const [shared, setShared] = useState<SharedPost | null>(null);
  const [params, setParams] = useSearchParams();
  const shareFailed = params.get("shared") === "failed";

  const load = async () => {
    const list = await api.inspirations();
    setItems(list);
    setSelectedId((id) => id ?? list[0]?.id ?? null);
    if (!list.length) setAdding(true);
  };
  useEffect(() => {
    void load();
    void takeSharedPost().then((post) => {
      if (!post) return;
      setShared(post);
      setSaved(null);
      setAdding(true);
    });
    if (params.has("shared")) setParams((p) => (p.delete("shared"), p), { replace: true });
  }, []);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  if (saved) return <SavedNotice post={saved} onAnother={() => setSaved(null)} />;

  return (
    <div>
      <PageHeader
        title="Remix a post you admire"
        subtitle="Bring someone else's post. Claude studies why it works and writes something original in your voice, about your own work, using the same craft."
      >
        <button className="btn-primary" onClick={() => setAdding(true)}>
          + Add a post
        </button>
      </PageHeader>

      <div className={`grid gap-6 ${items.length ? "lg:grid-cols-[280px_1fr]" : ""}`}>
        <aside className={`space-y-2 ${items.length ? "" : "hidden"}`}>
          {items.map((i) => (
            <button
              key={i.id}
              onClick={() => {
                setSelectedId(i.id);
                setAdding(false);
              }}
              className={`card block w-full p-3 text-left text-sm ${i.id === selectedId && !adding ? "border-brand-500 ring-2 ring-brand-100" : "hover:border-slate-300"}`}
            >
              <div className="font-medium">{i.analysis?.topic ?? "Saved post"}</div>
              <div className="mt-1 line-clamp-2 text-xs text-slate-500">{i.text}</div>
              {i.author && <div className="mt-1 text-xs text-slate-400">by {i.author}</div>}
            </button>
          ))}
        </aside>

        <div>
          {adding ? (
            <AddInspiration
              key={shared ? "shared" : "new"}
              initial={shared}
              notice={
                shareFailed && !shared
                  ? "The share didn't come through. Pick the screenshots below instead."
                  : shared && !shared.files.length
                    ? "LinkedIn doesn't let apps read a post from its link. Share screenshots of the post instead, or pick them below. The link is kept so you can open the original later."
                    : null
              }
              onCancel={items.length ? () => setAdding(false) : undefined}
              onAdded={(i) => {
                setItems((list) => [i, ...list]);
                setSelectedId(i.id);
                setAdding(false);
                setShared(null);
              }}
            />
          ) : selected ? (
            <RemixWorkspace
              key={selected.id}
              inspiration={selected}
              onDelete={async () => {
                await api.deleteInspiration(selected.id);
                setSelectedId(null);
                await load();
              }}
              onSaved={setSaved}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

const MAX_SCREENSHOTS = 6;
const isAndroid = /Android/i.test(navigator.userAgent);

interface Shot {
  file: File;
  url: string;
}

function toShots(files: File[]): Shot[] {
  return files.filter((f) => f.type.startsWith("image/")).map((file) => ({ file, url: URL.createObjectURL(file) }));
}

function AddInspiration({
  initial,
  notice,
  onAdded,
  onCancel,
}: {
  initial?: SharedPost | null;
  notice?: string | null;
  onAdded: (i: Inspiration) => void;
  onCancel?: () => void;
}) {
  const { me } = useApp();
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [shots, setShots] = useState<Shot[]>(() => toShots(initial?.files.slice(0, MAX_SCREENSHOTS) ?? []));
  const fileInput = useRef<HTMLInputElement>(null);
  const action = useAction();

  const latest = useRef(shots);
  latest.current = shots;
  useEffect(() => () => latest.current.forEach((s) => URL.revokeObjectURL(s.url)), []);

  const addFiles = (files: File[]) => {
    // Screenshots picked together arrive in no particular order; the time each was taken is a good guess.
    const sorted = [...files].sort((a, b) => a.lastModified - b.lastModified);
    setShots((list) => [...list, ...toShots(sorted)].slice(0, MAX_SCREENSHOTS));
  };
  const remove = (i: number) =>
    setShots((list) => {
      URL.revokeObjectURL(list[i].url);
      return list.filter((_, j) => j !== i);
    });
  const move = (i: number, by: number) =>
    setShots((list) => {
      const next = [...list];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });

  const submit = () =>
    action.run(async () => {
      const screenshotMediaIds: number[] = [];
      for (const s of shots) screenshotMediaIds.push((await uploadMedia(s.file)).id);
      onAdded(await api.addInspiration({ text, author: author || undefined, url: url || undefined, screenshotMediaIds }));
    });

  return (
    <div className="card space-y-4 p-5">
      <h2 className="font-semibold">Add a post to learn from</h2>
      {notice && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</p>}
      <div>
        <span className="label">Screenshots of the post</span>
        <p className="mb-2 text-xs text-slate-500">
          Long post? Add a screenshot for each part, top to bottom. Claude reads them in order and puts the full text back together.
          {isAndroid && " Tip: with Linkmein on your home screen, you can share screenshots straight to it from your gallery."}
        </p>
        {shots.length > 0 && (
          <ol className="mb-3 flex gap-3 overflow-x-auto pb-1">
            {shots.map((s, i) => (
              <li key={s.url} className="relative w-24 shrink-0">
                <img src={s.url} alt={`Screenshot ${i + 1}`} className="h-40 w-24 rounded-lg border object-cover object-top" />
                <span className="absolute left-1 top-1 rounded bg-slate-900/70 px-1.5 text-xs font-medium text-white">{i + 1}</span>
                <button
                  className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-900/70 text-sm text-white"
                  aria-label={`Remove screenshot ${i + 1}`}
                  onClick={() => remove(i)}
                >
                  ×
                </button>
                {shots.length > 1 && (
                  <div className="mt-1 flex justify-between">
                    <button className="btn-ghost px-2 py-0.5 text-xs" disabled={i === 0} aria-label={`Move screenshot ${i + 1} earlier`} onClick={() => move(i, -1)}>
                      ←
                    </button>
                    <button
                      className="btn-ghost px-2 py-0.5 text-xs"
                      disabled={i === shots.length - 1}
                      aria-label={`Move screenshot ${i + 1} later`}
                      onClick={() => move(i, 1)}
                    >
                      →
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        <button className="btn-secondary" disabled={shots.length >= MAX_SCREENSHOTS} onClick={() => fileInput.current?.click()}>
          {shots.length ? "+ Add more screenshots" : "Choose screenshots"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
      <div>
        <label className="label" htmlFor="insp-text">
          …or paste the text
        </label>
        <textarea id="insp-text" className="input min-h-[120px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="The full text of a LinkedIn post you like…" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="insp-author">
            Author (optional)
          </label>
          <input id="insp-author" className="input" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={shots.length ? "Read from the screenshots if empty" : ""} />
        </div>
        <div>
          <label className="label" htmlFor="insp-url">
            Link (optional)
          </label>
          <input id="insp-url" className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.linkedin.com/posts/…" />
          <p className="mt-1 text-xs text-slate-500">Kept as a reference so you can open the original. Linkmein doesn't read posts from links.</p>
        </div>
      </div>
      <ErrorText error={action.error} />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn-primary" disabled={action.busy || (!text.trim() && !shots.length) || !me.settings.hasApiKey} onClick={submit}>
          {action.busy ? <Spinner /> : null} {action.busy ? "Analyzing…" : "Analyze post"}
        </button>
      </div>
    </div>
  );
}

function RemixWorkspace({ inspiration, onDelete, onSaved }: { inspiration: Inspiration; onDelete: () => void; onSaved: (p: Post) => void }) {
  const { media, refresh } = useMediaLibrary();
  const [notes, setNotes] = useState("");
  const [material, setMaterial] = useState<number[]>([]);
  const [length, setLength] = useState<PostLength | "">("");
  const [drafts, setDrafts] = useState<RemixDraft[]>([]);
  const [editing, setEditing] = useState<EditorValue | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const gen = useAction();
  const a = inspiration.analysis;

  const generate = () =>
    gen.run(async () => {
      const res = await api.remix(inspiration.id, { notes, mediaIds: material, variations: 3, length: length || undefined });
      setDrafts(res.drafts);
      setEditing(null);
    });

  const pick = (text: string) => {
    const visual = media.filter((m) => material.includes(m.id) && m.kind !== "audio" && m.status === "ready");
    const video = visual.find((m) => m.kind === "video");
    setEditing({ text, mediaIds: video ? [video.id] : visual.map((m) => m.id), visibility: "PUBLIC", scheduledAt: null });
    setTimeout(() => document.getElementById("remix-editor")?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{a?.topic ?? "Saved post"}</h2>
            {inspiration.author && <p className="text-sm text-slate-500">by {inspiration.author}</p>}
          </div>
          <div className="flex gap-2">
            {inspiration.url && (
              <a className="btn-ghost px-2 py-1 text-xs" href={inspiration.url} target="_blank" rel="noreferrer">
                Open original
              </a>
            )}
            <button className="btn-danger px-2 py-1 text-xs" onClick={onDelete}>
              Delete
            </button>
          </div>
        </div>
        {a && (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <Fact label="Hook">{a.hookStyle}</Fact>
            <Fact label="Tone">{a.tone}</Fact>
            <Fact label="Structure">
              <ol className="list-decimal space-y-0.5 pl-5">
                {a.structure.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </Fact>
            <Fact label="Formatting">{a.formatting}</Fact>
            <div className="sm:col-span-2">
              <Fact label="Why it works">{a.whyItWorks}</Fact>
            </div>
          </dl>
        )}
        <button className="btn-ghost mt-3 px-2 py-1 text-xs" onClick={() => setShowOriginal((s) => !s)}>
          {showOriginal ? "Hide" : "Show"} original post
        </button>
        {showOriginal && (
          <div className="mt-2 space-y-3">
            <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">{inspiration.text}</p>
            {inspiration.screenshotMediaIds.length > 0 && (
              <div className="flex gap-3 overflow-x-auto pb-1">
                {inspiration.screenshotMediaIds.map((id, i) => (
                  <img key={id} src={previewUrl(id)} alt={`Screenshot ${i + 1} of the original post`} className="max-h-80 shrink-0 rounded-lg border" />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card space-y-4 p-5">
        <h2 className="font-semibold">Your version</h2>
        <div>
          <label className="label" htmlFor="remix-notes">
            What should yours be about?
          </label>
          <textarea
            id="remix-notes"
            className="input min-h-[100px]"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Your own story, lesson or news. Leave empty and Claude picks a topic from your profile."
          />
        </div>
        <MediaTray library={media} refresh={refresh} selected={material} onChange={setMaterial} label="Your material (optional)" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <label className="label" htmlFor="remix-length">
              Length
            </label>
            <select id="remix-length" className="input" value={length} onChange={(e) => setLength(e.target.value as PostLength | "")}>
              <option value="">Like the original</option>
              <option value="short">Short</option>
              <option value="medium">Medium</option>
              <option value="long">Long</option>
            </select>
          </div>
          <button className="btn-primary" disabled={gen.busy || media.some((m) => material.includes(m.id) && m.status === "processing")} onClick={generate}>
            {gen.busy ? <Spinner /> : "✨"} {gen.busy ? "Writing…" : "Write my version"}
          </button>
        </div>
        <ErrorText error={gen.error} />
      </div>

      {drafts.length > 0 && (
        <section>
          <h2 className="mb-1 text-lg font-semibold">Pick a draft</h2>
          <p className="mb-3 text-sm text-slate-500">Each draft shows how much wording it shares with the original. Claude rewrites drafts that copy too much.</p>
          <DraftList drafts={drafts} onPick={(d) => pick(d.text)} />
        </section>
      )}

      {editing && (
        <section id="remix-editor">
          <h2 className="mb-3 text-lg font-semibold">Edit and schedule</h2>
          <PostEditor key={editing.text} initial={editing} library={media} source="remix" inspirationId={inspiration.id} onSaved={onSaved} />
        </section>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-slate-700">{children}</dd>
    </div>
  );
}
