import { useState } from "react";
import { api, type Post } from "../api";
import { useMediaLibrary, useAction } from "../hooks";
import { useApp } from "../context";
import { MediaTray } from "../components/MediaTray";
import { DraftList } from "../components/DraftList";
import { PostEditor, type EditorValue } from "../components/PostEditor";
import { SavedNotice } from "../components/SavedNotice";
import { ErrorText, PageHeader, Spinner } from "../components/ui";
import { POST_GOALS, type PostDraft, type PostLength } from "../../../shared/types";

export function CreatePage() {
  const { me } = useApp();
  const { media, refresh } = useMediaLibrary();
  const [material, setMaterial] = useState<number[]>([]);
  const [notes, setNotes] = useState("");
  const [goal, setGoal] = useState("");
  const [tone, setTone] = useState("");
  const [length, setLength] = useState<PostLength>("medium");
  const [variations, setVariations] = useState(3);
  const [drafts, setDrafts] = useState<PostDraft[]>([]);
  const [editing, setEditing] = useState<EditorValue | null>(null);
  const [saved, setSaved] = useState<Post | null>(null);
  const gen = useAction();

  const selected = media.filter((m) => material.includes(m.id));
  const processing = selected.some((m) => m.status === "processing");
  const visualIds = selected.filter((m) => m.kind !== "audio" && m.status === "ready").map((m) => m.id);

  const generate = () =>
    gen.run(async () => {
      const res = await api.generate({ mediaIds: material, notes, goal: goal || undefined, tone: tone || undefined, length, variations });
      setDrafts(res.drafts);
      setEditing(null);
      await refresh(); // picks up AI alt text
    });

  const pick = (text: string) => {
    // A single video can't be combined with images on LinkedIn; default to the video alone.
    const video = selected.find((m) => m.kind === "video" && m.status === "ready");
    setEditing({ text, mediaIds: video ? [video.id] : visualIds, visibility: "PUBLIC", scheduledAt: null });
    setTimeout(() => document.getElementById("editor")?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  const reset = () => {
    setSaved(null);
    setDrafts([]);
    setEditing(null);
    setMaterial([]);
    setNotes("");
  };

  if (saved) return <SavedNotice post={saved} onAnother={reset} />;

  return (
    <div className="space-y-8">
      <PageHeader title="Create a post" subtitle="Give Claude your photos, videos, voice notes and a few words. It writes in your voice using what it knows about you." />

      <section className="card space-y-5 p-5">
        <MediaTray library={media} refresh={refresh} selected={material} onChange={setMaterial} label="Photos, videos and voice notes" />

        <div>
          <label className="label" htmlFor="notes">
            What's this about?
          </label>
          <textarea
            id="notes"
            className="input min-h-[110px]"
            placeholder="A few words or bullet points: what happened, why it matters, anything Claude should mention or avoid."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          <div>
            <label className="label" htmlFor="goal">
              Goal
            </label>
            <select id="goal" className="input" value={goal} onChange={(e) => setGoal(e.target.value)}>
              <option value="">Let Claude decide</option>
              {POST_GOALS.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tone">
              Tone (optional)
            </label>
            <input id="tone" className="input" placeholder="e.g. warm, candid, witty" value={tone} onChange={(e) => setTone(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="length">
              Length
            </label>
            <select id="length" className="input" value={length} onChange={(e) => setLength(e.target.value as PostLength)}>
              <option value="short">Short</option>
              <option value="medium">Medium</option>
              <option value="long">Long</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="variations">
              Variations
            </label>
            <select id="variations" className="input" value={variations} onChange={(e) => setVariations(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>

        <ErrorText error={gen.error} />
        <div className="flex flex-wrap items-center justify-end gap-3">
          <button className="btn-ghost" onClick={() => pick(notes)}>
            Write it myself
          </button>
          <button
            className="btn-primary"
            disabled={gen.busy || processing || !me.settings.hasApiKey || (!material.length && !notes.trim())}
            onClick={generate}
            title={!me.settings.hasApiKey ? "Add your Anthropic API key in Settings" : undefined}
          >
            {gen.busy ? <Spinner /> : "✨"} {gen.busy ? "Writing…" : drafts.length ? "Write new drafts" : "Write drafts"}
          </button>
        </div>
      </section>

      {drafts.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Pick a draft</h2>
          <DraftList drafts={drafts} onPick={(d) => pick(d.text)} />
        </section>
      )}

      {editing && (
        <section id="editor">
          <h2 className="mb-3 text-lg font-semibold">Edit and schedule</h2>
          <PostEditor key={editing.text} initial={editing} library={media} source="create" onSaved={setSaved} />
        </section>
      )}
    </div>
  );
}
