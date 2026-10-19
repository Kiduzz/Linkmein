import { useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { useAction } from "../hooks";
import { ErrorText, formatWhen, PageHeader, Spinner } from "../components/ui";

export function SettingsPage() {
  const { me, config, refreshMe } = useApp();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(me.settings.model);
  const keyAction = useAction();
  const modelAction = useAction();

  const saveKey = () =>
    keyAction.run(async () => {
      await api.saveSettings({ apiKey: apiKey.trim() });
      setApiKey("");
      await refreshMe();
    });

  const removeKey = () =>
    keyAction.run(async () => {
      if (!window.confirm("Remove your API key? AI features stop working until you add one.")) return;
      await api.removeApiKey();
      await refreshMe();
    });

  const saveModel = (value: string) => {
    setModel(value);
    void modelAction.run(async () => {
      await api.saveSettings({ model: value });
      await refreshMe();
    });
  };

  const li = me.linkedin;
  const daysLeft = li.expiresAt ? Math.floor((li.expiresAt - Date.now()) / 86_400_000) : null;

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Settings" />

      <section className="card space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Claude API key</h2>
          <p className="text-sm text-slate-600">
            Linkmein uses your own Anthropic API key, so you only pay Anthropic for what you use. Create one at{" "}
            <a className="text-brand-700 underline" href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">
              platform.claude.com
            </a>
            . A Claude.ai chat subscription doesn't include API access. The key is encrypted on this server and never sent to your browser.
          </p>
        </div>
        {me.settings.hasApiKey && (
          <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            <span>
              Key saved: <code>{me.settings.apiKeyMasked}</code>
            </span>
            <button className="btn-danger px-2 py-1 text-xs" onClick={removeKey}>
              Remove
            </button>
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveKey();
          }}
        >
          <input
            type="password"
            className="input font-mono"
            placeholder={me.settings.hasApiKey ? "Replace with a new key" : "sk-ant-…"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
          <button className="btn-primary" disabled={keyAction.busy || !apiKey.trim()}>
            {keyAction.busy ? <Spinner /> : null} {keyAction.busy ? "Checking…" : "Save key"}
          </button>
        </form>
        <ErrorText error={keyAction.error} />

        <div>
          <label className="label" htmlFor="model">
            Model
          </label>
          <select id="model" className="input" value={model} onChange={(e) => saveModel(e.target.value)}>
            {config.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="hint">Opus writes the best posts. Sonnet and Haiku cost less per post.</p>
          <ErrorText error={modelAction.error} />
        </div>
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="font-semibold">LinkedIn</h2>
        {li.dryRun && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Dry-run mode is on (<code>LINKEDIN_DRY_RUN=true</code>): posts are marked published but nothing is sent to LinkedIn.
          </p>
        )}
        {li.connected ? (
          <p className="text-sm text-slate-700">
            Connected as <strong>{me.user.name}</strong>.{" "}
            {li.expiresAt && (daysLeft! > 0 ? `Access expires ${formatWhen(li.expiresAt)} (${daysLeft} days).` : "Access has expired.")} LinkedIn asks members to
            reconnect every 60 days; scheduled posts fail if access lapses.
          </p>
        ) : (
          <p className="text-sm text-slate-700">Not connected. Connect to publish posts.</p>
        )}
        {config.linkedinConfigured && (
          <a href="/auth/linkedin" className="btn-secondary">
            {li.connected ? "Reconnect LinkedIn" : "Connect LinkedIn"}
          </a>
        )}
      </section>
    </div>
  );
}
