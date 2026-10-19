import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { config, linkedinConfigured } from "./config.js";
import { randomToken } from "./crypto.js";
import { authorizeUrl, exchangeCode, fetchUserInfo } from "./linkedin.js";
import { upsertAccount } from "./accounts.js";

const SESSION_COOKIE = "lmi_session";
const STATE_COOKIE = "lmi_oauth_state";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The signed-in LinkedIn account's storage key. */
      accountKey?: string;
    }
  }
}

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.baseUrl.startsWith("https://"),
  path: "/",
});

// Sessions are stateless signed cookies, so the server needs no session table.
const sign = (data: string) => crypto.createHmac("sha256", `session:${config.appSecret}`).update(data).digest("base64url");

export function sessionToken(accountKey: string, expiresAt = Date.now() + SESSION_TTL_MS): string {
  const data = Buffer.from(JSON.stringify({ a: accountKey, e: expiresAt })).toString("base64url");
  return `${data}.${sign(data)}`;
}

export function readSessionToken(token: string): string | null {
  const [data, mac] = token.split(".");
  if (!data || !mac) return null;
  const expected = Buffer.from(sign(data));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { a, e } = JSON.parse(Buffer.from(data, "base64url").toString()) as { a: string; e: number };
    return typeof a === "string" && e > Date.now() ? a : null;
  } catch {
    return null;
  }
}

export function createSession(res: Response, accountKey: string): void {
  res.cookie(SESSION_COOKIE, sessionToken(accountKey), { ...cookieOptions(), maxAge: SESSION_TTL_MS });
}

/** Attaches req.accountKey when the session cookie is valid. */
export function loadSession(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string" && token) req.accountKey = readSessionToken(token) ?? undefined;
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.accountKey) {
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
    const account = await upsertAccount(info, tokens);
    createSession(res, account.key);
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
  const account = await upsertAccount({ sub: "dev-user", name: "Dev User", email: null, picture: null }, null);
  createSession(res, account.key);
  res.json({ ok: true });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.json({ ok: true });
});
