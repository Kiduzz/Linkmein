import { Router, type NextFunction, type Request, type Response } from "express";
import { config, linkedinConfigured } from "./config.js";
import { get, now, run, type UserRow } from "./db.js";
import { randomToken, sha256 } from "./crypto.js";
import { authorizeUrl, exchangeCode, fetchUserInfo } from "./linkedin.js";
import { getUser, upsertLinkedInUser } from "./users.js";

const SESSION_COOKIE = "lmi_session";
const STATE_COOKIE = "lmi_oauth_state";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.baseUrl.startsWith("https://"),
  path: "/",
});

export async function createSession(res: Response, userId: number): Promise<void> {
  const token = randomToken();
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [sha256(token), userId, now() + SESSION_TTL_MS]);
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_TTL_MS });
}

/** Attaches req.user when the session cookie is valid. */
export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string" && token) {
    const row = await get<{ user_id: number; expires_at: number }>("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", [sha256(token)]);
    if (row && row.expires_at > now()) req.user = await getUser(row.user_id);
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  next();
}

/**
 * Cookie-authenticated APIs need CSRF protection. Browsers won't send a custom
 * header cross-site without a CORS preflight, which we never approve.
 */
export function requireCsrfHeader(req: Request, res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.get("x-linkmein") === "1") {
    next();
    return;
  }
  res.status(403).json({ error: "Missing X-Linkmein header" });
}

export const authRouter = Router();

authRouter.get("/linkedin", (_req, res) => {
  if (!linkedinConfigured()) {
    res.status(500).send("LinkedIn is not configured. Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET.");
    return;
  }
  const state = randomToken(16);
  res.cookie(STATE_COOKIE, state, { ...cookieOptions(), maxAge: 10 * 60 * 1000 });
  res.redirect(authorizeUrl(state));
});

authRouter.get("/linkedin/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string | undefined>;
  const expected = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, cookieOptions());
  if (error) {
    res.redirect(`${config.webUrl}/login?error=${encodeURIComponent(error_description ?? error)}`);
    return;
  }
  if (!code || !state || state !== expected) {
    res.redirect(`${config.webUrl}/login?error=${encodeURIComponent("Sign-in expired, please try again.")}`);
    return;
  }
  try {
    const tokens = await exchangeCode(code);
    const info = await fetchUserInfo(tokens.accessToken);
    const user = await upsertLinkedInUser(info, tokens);
    await createSession(res, user.id);
    res.redirect(`${config.webUrl}/`);
  } catch (err) {
    console.error("LinkedIn sign-in failed", err);
    res.redirect(`${config.webUrl}/login?error=${encodeURIComponent((err as Error).message)}`);
  }
});

/** Local development without a LinkedIn app. Publishing is unavailable for this user unless LINKEDIN_DRY_RUN=true. */
authRouter.post("/dev-login", async (_req, res) => {
  if (!config.allowDevLogin) {
    res.status(404).end();
    return;
  }
  const user = await upsertLinkedInUser({ sub: "dev-user", name: "Dev User", email: null, picture: null }, null);
  await createSession(res, user.id);
  res.json({ ok: true });
});

authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string") await run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.json({ ok: true });
});
