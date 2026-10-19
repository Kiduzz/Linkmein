import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { useAction } from "../hooks";
import { ErrorText, PageHeader, Spinner } from "../components/ui";
import type { Profile } from "../../../shared/types";

type TextField = Exclude<keyof Profile, "emoji" | "hashtags">;

const FIELDS: { key: TextField; label: string; hint?: string; rows?: number; placeholder?: string }[] = [
  { key: "headline", label: "Headline", placeholder: "Founder at Acme · Helping teams ship faster" },
  { key: "about", label: "About you", rows: 4, hint: "Your background, what you do, what you care about." },
  { key: "industry", label: "Industry or field" },
  { key: "audience", label: "Who you're writing for", placeholder: "e.g. engineering managers at startups" },
  { key: "goals", label: "What you want from LinkedIn", placeholder: "e.g. hire senior engineers, find design partners, build a reputation in climate tech" },
  { key: "topics", label: "Topics you post about", rows: 2 },
  {
    key: "experiences",
    label: "Stories, wins and opinions Claude may use",
    rows: 5,
    hint: "Facts only you know: career moments, numbers you're proud of, strong opinions. Claude never invents these.",
  },
  { key: "tone", label: "Your tone", placeholder: "e.g. direct, warm, a little dry humor" },
  { key: "avoid", label: "Never say or mention", rows: 2, placeholder: "e.g. my employer's name, buzzwords like 'synergy', politics" },
  { key: "callToAction", label: "Preferred call to action", placeholder: "e.g. invite people to DM me, or none" },
  { key: "language", label: "Language", placeholder: "English (leave empty to match your notes)" },
];

export function ProfilePage() {
  const { me } = useApp();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const save = useAction();
  const voice = useAction();

  useEffect(() => {
    api.profile().then(setProfile);
  }, []);

  if (!profile) return <p className="text-slate-500">Loading…</p>;

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => setProfile({ ...profile, [key]: value });

  const submit = () =>
    save.run(async () => {
      setProfile(await api.saveProfile(profile));
      setSavedAt(Date.now());
    });

  const analyze = () =>
    voice.run(async () => {
      await api.saveProfile(profile);
      const { voiceGuide } = await api.analyzeVoice();
      setProfile({ ...profile, voiceGuide });
    });

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="About you" subtitle="Claude reads this before every post. The more specific you are, the more it sounds like you." />

      <section className="card space-y-4 p-5">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label className="label" htmlFor={f.key}>
              {f.label}
            </label>
            {f.rows ? (
              <textarea id={f.key} className="input" rows={f.rows} placeholder={f.placeholder} value={profile[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />
            ) : (
              <input id={f.key} className="input" placeholder={f.placeholder} value={profile[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />
            )}
            {f.hint && <p className="hint">{f.hint}</p>}
          </div>
        ))}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="emoji">
              Emoji
            </label>
            <select id="emoji" className="input" value={profile.emoji ?? "light"} onChange={(e) => set("emoji", e.target.value as Profile["emoji"])}>
              <option value="none">None</option>
              <option value="light">A few</option>
              <option value="expressive">Expressive</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="hashtags">
              Hashtags
            </label>
            <select id="hashtags" className="input" value={profile.hashtags ?? "few"} onChange={(e) => set("hashtags", e.target.value as Profile["hashtags"])}>
              <option value="none">None</option>
              <option value="few">2-3</option>
              <option value="several">3-5</option>
            </select>
          </div>
        </div>
      </section>

      <section className="card space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Your voice</h2>
          <p className="text-sm text-slate-600">Paste a few posts you've written. Claude matches their style, and can distill them into a voice guide.</p>
        </div>
        <div>
          <label className="label" htmlFor="samples">
            Writing samples
          </label>
          <textarea
            id="samples"
            className="input font-mono text-xs"
            rows={10}
            placeholder={"Paste one post…\n---\nThen a line with three dashes, then the next post."}
            value={profile.writingSamples ?? ""}
            onChange={(e) => set("writingSamples", e.target.value)}
          />
          <p className="hint">Separate posts with a line containing only ---</p>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="label" htmlFor="voice">
              Voice guide
            </label>
            <button className="btn-secondary px-3 py-1 text-xs" disabled={voice.busy || !profile.writingSamples?.trim() || !me.settings.hasApiKey} onClick={analyze}>
              {voice.busy ? <Spinner /> : "✨"} Analyze my voice
            </button>
          </div>
          <textarea
            id="voice"
            className="input"
            rows={8}
            placeholder="Generated from your samples, or write your own style rules."
            value={profile.voiceGuide ?? ""}
            onChange={(e) => set("voiceGuide", e.target.value)}
          />
          <ErrorText error={voice.error} />
        </div>
      </section>

      <div className="sticky bottom-4 flex items-center justify-end gap-3">
        {savedAt && !save.busy && <span className="text-sm text-emerald-700">Saved</span>}
        <ErrorText error={save.error} />
        <button className="btn-primary shadow-lg" disabled={save.busy} onClick={submit}>
          Save profile
        </button>
      </div>
    </div>
  );
}
