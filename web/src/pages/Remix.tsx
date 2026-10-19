import { useEffect, useRef, useState } from "react";
import { api, previewUrl, type Inspiration, type Post } from "../api";
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

  const load = async () => {
    const list = await api.inspirations();
    setItems(list);
    setSelectedId((id) => id ?? list[0]?.id ?? null);
    if (!list.length) setAdding(true);
  };
  useEffect(() => {
    void load();
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
              onCancel={items.length ? () => setAdding(false) : undefined}
              onAdded={(i) => {
                setItems((list) => [i, ...list]);
                setSelectedId(i.id);
                setAdding(false);
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

function AddInspiration({ onAdded, onCancel }: { onAdded: (i: Inspiration) => void; onCancel?: () => void }) {
  const { me, config } = useApp();
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [url, setUrl] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const action = useAction();

  const submit = () =>
    action.run(async () => {
      let screenshotMediaId: number | undefined;
      if (screenshot) screenshotMediaId = (await uploadMedia(screenshot, me.user.id, config)).id;
      onAdded(await api.addInspiration({ text, author: author || undefined, url: url || undefined, screenshotMediaId }));
    });

  return (
    <div className="card space-y-4 p-5">
      <h2 className="font-semibold">Add a post to learn from</h2>
      <div>
        <label className="label" htmlFor="insp-text">
          Paste the post
        </label>
        <textarea id="insp-text" className="input min-h-[200px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="Copy the full text of a LinkedIn post you like…" />
      </div>
      <div>
        <span className="label">…or upload a screenshot of it</span>
        <div className="flex items-center gap-3">
          <button className="btn-secondary" onClick={() => fileInput.current?.click()}>
            {screenshot ? "Change screenshot" : "Choose screenshot"}
          </button>
          {screenshot && <span className="text-sm text-slate-600">{screenshot.name}</span>}
        </div>
        <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => setScreenshot(e.target.files?.[0] ?? null)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="insp-author">
            Author (optional)
          </label>
          <input id="insp-author" className="input" value={author} onChange={(e) => setAuthor(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="insp-url">
            Link (optional)
          </label>
          <input id="insp-url" className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.linkedin.com/posts/…" />
        </div>
      </div>
      <ErrorText error={action.error} />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn-primary" disabled={action.busy || (!text.trim() && !screenshot) || !me.settings.hasApiKey} onClick={submit}>
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
          <div className="mt-2 flex gap-4">
            <p className="flex-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">{inspiration.text}</p>
            {inspiration.screenshotMediaId && <img src={previewUrl(inspiration.screenshotMediaId)} alt="Screenshot of the original post" className="max-h-80 rounded-lg border" />}
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
