import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type AppConfig } from "../api";

export function LoginPage({ config, onLogin }: { config: AppConfig; onLogin: () => Promise<void> }) {
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const error = params.get("error");

  const devLogin = async () => {
    setBusy(true);
    await api.devLogin();
    await onLogin();
    window.history.replaceState(null, "", "/");
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-md p-8 text-center">
        <img src="/favicon.svg" alt="" className="mx-auto mb-4 h-12 w-12" />
        <h1 className="text-2xl font-semibold">Linkmein</h1>
        <p className="mt-2 text-sm text-slate-600">
          Turn your photos, voice notes and videos into LinkedIn posts that sound like you, then schedule them. Open source, using your own Claude API key.
        </p>
        {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="mt-6 space-y-3">
          {config.linkedinConfigured ? (
            <a href="/auth/linkedin" className="btn-primary w-full py-2.5">
              Sign in with LinkedIn
            </a>
          ) : (
            <p className="rounded-lg bg-amber-50 p-3 text-left text-sm text-amber-900">
              LinkedIn sign-in isn't configured on this server yet. Set <code>LINKEDIN_CLIENT_ID</code> and <code>LINKEDIN_CLIENT_SECRET</code> (see the README).
            </p>
          )}
          {config.devLogin && (
            <button className="btn-secondary w-full" disabled={busy} onClick={devLogin}>
              Continue as local dev user
            </button>
          )}
        </div>
        <p className="mt-6 text-xs text-slate-500">
          We ask LinkedIn for permission to read your basic profile and to post on your behalf. Nothing is posted without you choosing to.
        </p>
      </div>
    </div>
  );
}
