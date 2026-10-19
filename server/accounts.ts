import { decrypt, encrypt, sha256 } from "./crypto.js";
import { LinkedInError, refreshAccessToken, type LinkedInUser, type TokenSet } from "./linkedin.js";
import { readJson, updateJson } from "./storage.js";

// A LinkedIn connection: the one thing the server must hold to publish while the
// user's phone is off. Tokens are encrypted with APP_SECRET.

export interface Account {
  key: string;
  sub: string;
  name: string;
  email: string | null;
  picture: string | null;
  tokenEnc: string | null;
  expiresAt: number | null;
  refreshEnc: string | null;
  refreshExpiresAt: number | null;
  createdAt: number;
}

/** Stable, opaque id for a LinkedIn member, used in storage paths. */
export const accountKey = (sub: string) => sha256(`account:${sub}`).slice(0, 24);
const path = (key: string) => `accounts/${key}.json`;

export async function getAccount(key: string, { fresh = false } = {}): Promise<Account | null> {
  return (await readJson<Account>(path(key), { fresh }))?.value ?? null;
}

function tokenFields(t: TokenSet): Partial<Account> {
  return {
    tokenEnc: encrypt(t.accessToken),
    expiresAt: t.expiresAt,
    // LinkedIn only returns refresh tokens to approved apps; keep an old one if none comes back.
    ...(t.refreshToken ? { refreshEnc: encrypt(t.refreshToken), refreshExpiresAt: t.refreshExpiresAt } : {}),
  };
}

export async function upsertAccount(info: LinkedInUser, tokens: TokenSet | null): Promise<Account> {
  const key = accountKey(info.sub);
  const blank: Account = {
    key,
    sub: info.sub,
    name: info.name,
    email: info.email,
    picture: info.picture,
    tokenEnc: null,
    expiresAt: null,
    refreshEnc: null,
    refreshExpiresAt: null,
    createdAt: Date.now(),
  };
  return updateJson<Account>(path(key), blank, (current) => ({
    ...current,
    name: info.name,
    email: info.email,
    picture: info.picture,
    ...(tokens ? tokenFields(tokens) : {}),
  }));
}

const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Returns a usable LinkedIn access token, refreshing it when we can. */
export async function getLinkedInToken(account: Account): Promise<string> {
  if (!account.tokenEnc || !account.expiresAt) {
    throw new LinkedInError("LinkedIn is not connected. Reconnect your account in Settings.", 401);
  }
  const expiresSoon = account.expiresAt - Date.now() < REFRESH_MARGIN_MS;
  if (expiresSoon && account.refreshEnc && (account.refreshExpiresAt ?? Infinity) > Date.now()) {
    const tokens = await refreshAccessToken(decrypt(account.refreshEnc));
    await updateJson<Account>(path(account.key), account, (current) => ({ ...current, ...tokenFields(tokens) }));
    return tokens.accessToken;
  }
  if (account.expiresAt <= Date.now()) {
    throw new LinkedInError("Your LinkedIn connection expired. Reconnect your account in Settings.", 401);
  }
  return decrypt(account.tokenEnc);
}
