import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, ApiError, type AppConfig, type Me } from "./api";
import { AppContext, useApp } from "./context";
import { LoginPage } from "./pages/Login";
import { CreatePage } from "./pages/Create";
import { RemixPage } from "./pages/Remix";
import { SchedulePage } from "./pages/Schedule";
import { LibraryPage } from "./pages/Library";
import { ProfilePage } from "./pages/Profile";
import { SettingsPage } from "./pages/Settings";

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    api.config().then(setConfig, (err) => setError(err.message));
    void refreshMe();
  }, [refreshMe]);

  if (error) return <div className="p-8 text-red-600">Couldn't reach the Linkmein server: {error}</div>;
  if (!config || me === undefined) return <div className="p-8 text-slate-500">Loading…</div>;

  if (me === null) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage config={config} onLogin={refreshMe} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <AppContext.Provider value={{ me, config, refreshMe }}>
      <Layout>
        <Routes>
          <Route path="/" element={<CreatePage />} />
          <Route path="/remix" element={<RemixPage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </AppContext.Provider>
  );
}

const NAV = [
  { to: "/", label: "Create" },
  { to: "/remix", label: "Remix" },
  { to: "/schedule", label: "Schedule" },
  { to: "/library", label: "Library" },
  { to: "/profile", label: "About you" },
  { to: "/settings", label: "Settings" },
];

function Layout({ children }: { children: React.ReactNode }) {
  const { me } = useApp();
  const navigate = useNavigate();
  const location = useLocation();

  const logout = async () => {
    await api.logout();
    window.location.href = "/login";
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span>Linkmein</span>
          </Link>
          <nav className="order-last -mx-1 flex w-full gap-1 overflow-x-auto md:order-none md:mx-0 md:w-auto md:flex-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end
                className={({ isActive }) =>
                  `whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${isActive ? "bg-brand-50 font-medium text-brand-700" : "text-slate-600 hover:bg-slate-100"}`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Avatar name={me.user.name} picture={me.user.picture} size={32} />
            <button className="btn-ghost px-2 py-1" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <SetupBanner onNavigate={navigate} hidden={location.pathname === "/settings"} />
        {children}
      </main>
    </div>
  );
}

function SetupBanner({ onNavigate, hidden }: { onNavigate: (to: string) => void; hidden: boolean }) {
  const { me } = useApp();
  if (hidden) return null;
  const expiresSoon = me.linkedin.expiresAt !== null && me.linkedin.expiresAt - Date.now() < 7 * 86_400_000;
  const items: { text: string; to: string; action: string }[] = [];
  if (!me.settings.hasApiKey) items.push({ text: "Add your Anthropic API key so Claude can write posts for you.", to: "/settings", action: "Add key" });
  if (!me.linkedin.dryRun && (!me.linkedin.connected || expiresSoon))
    items.push({
      text: me.linkedin.connected ? "Your LinkedIn connection expires soon. Reconnect to keep scheduled posts going." : "Connect LinkedIn to publish posts.",
      to: "/settings",
      action: "Fix",
    });
  if (!items.length) return null;
  return (
    <div className="mb-6 space-y-2">
      {items.map((i) => (
        <div key={i.text} className="flex items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>{i.text}</span>
          <button className="btn-secondary py-1" onClick={() => onNavigate(i.to)}>
            {i.action}
          </button>
        </div>
      ))}
    </div>
  );
}

export function Avatar({ name, picture, size = 40 }: { name: string; picture: string | null; size?: number }) {
  if (picture) return <img src={picture} alt="" className="rounded-full object-cover" style={{ width: size, height: size }} />;
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="flex items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {initials}
    </div>
  );
}
