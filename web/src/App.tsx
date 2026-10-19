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

type IconName = "create" | "remix" | "schedule" | "library" | "you" | "settings";

/** Simple line icons for the navigation. */
function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    create: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
    remix: <path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />,
    schedule: (
      <>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </>
    ),
    library: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </>
    ),
    you: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {paths[name]}
    </svg>
  );
}

const NAV: { to: string; label: string; short: string; icon: IconName }[] = [
  { to: "/", label: "Create", short: "Create", icon: "create" },
  { to: "/remix", label: "Remix", short: "Remix", icon: "remix" },
  { to: "/schedule", label: "Schedule", short: "Schedule", icon: "schedule" },
  { to: "/library", label: "Library", short: "Library", icon: "library" },
  { to: "/profile", label: "About you", short: "You", icon: "you" },
];

function Layout({ children }: { children: React.ReactNode }) {
  const { me } = useApp();
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span>Linkmein</span>
          </Link>
          {/* Desktop: tabs in the header. Phones get a bottom tab bar instead. */}
          <nav className="hidden flex-1 gap-1 md:flex">
            {[...NAV, { to: "/settings", label: "Settings", short: "Settings", icon: "settings" as const }].map((n) => (
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
          <div className="ml-auto flex items-center gap-1">
            <NavLink
              to="/settings"
              aria-label="Settings"
              className={({ isActive }) => `rounded-lg p-2 md:hidden ${isActive ? "bg-brand-50 text-brand-700" : "text-slate-600"}`}
            >
              <Icon name="settings" />
            </NavLink>
            <Avatar name={me.user.name} picture={me.user.picture} size={32} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 pb-28 md:pb-10">
        <SetupBanner onNavigate={navigate} hidden={location.pathname === "/settings"} />
        {children}
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="Main">
        <div className="grid grid-cols-5">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end
              className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? "font-medium text-brand-700" : "text-slate-500"}`}
            >
              <Icon name={n.icon} className="h-6 w-6" />
              {n.short}
            </NavLink>
          ))}
        </div>
      </nav>
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
        <div key={i.text} className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>{i.text}</span>
          <button className="btn-secondary shrink-0 whitespace-nowrap py-1" onClick={() => onNavigate(i.to)}>
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
