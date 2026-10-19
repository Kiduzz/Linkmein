import { get, now, run, type UserRow } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { LinkedInError, refreshAccessToken, type LinkedInUser, type TokenSet } from "./linkedin.js";
import type { Profile } from "../shared/types.js";
import { config } from "./config.js";

export function getUser(id: number): Promise<UserRow | undefined> {
  return get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
}

export async function upsertLinkedInUser(info: LinkedInUser, tokens: TokenSet | null): Promise<UserRow> {
  const existing = await get<UserRow>("SELECT * FROM users WHERE linkedin_sub = ?", [info.sub]);
  let id: number;
  if (existing) {
    id = existing.id;
    await run("UPDATE users SET name = ?, email = ?, picture = ? WHERE id = ?", [info.name, info.email, info.picture, id]);
  } else {
    const result = await run(
      `INSERT INTO users (linkedin_sub, name, email, picture, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [info.sub, info.name, info.email, info.picture, config.ai.defaultModel, now()],
    );
    id = result.lastId;
  }
  if (tokens) await saveTokens(id, tokens);
  return (await getUser(id))!;
}

async function saveTokens(userId: number, t: TokenSet): Promise<void> {
  await run(
    `UPDATE users SET linkedin_token_enc = ?, linkedin_token_expires_at = ?,
       linkedin_refresh_enc = COALESCE(?, linkedin_refresh_enc),
       linkedin_refresh_expires_at = COALESCE(?, linkedin_refresh_expires_at)
     WHERE id = ?`,
    [encrypt(t.accessToken), t.expiresAt, t.refreshToken ? encrypt(t.refreshToken) : null, t.refreshExpiresAt, userId],
  );
}

const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Returns a usable LinkedIn access token, refreshing it when we can. */
export async function getLinkedInToken(user: UserRow): Promise<string> {
  if (!user.linkedin_token_enc || !user.linkedin_token_expires_at) {
    throw new LinkedInError("LinkedIn is not connected. Reconnect your account in Settings.", 401);
  }
  const expiresSoon = user.linkedin_token_expires_at - now() < REFRESH_MARGIN_MS;
  if (expiresSoon && user.linkedin_refresh_enc && (user.linkedin_refresh_expires_at ?? Infinity) > now()) {
    const tokens = await refreshAccessToken(decrypt(user.linkedin_refresh_enc));
    await saveTokens(user.id, tokens);
    return tokens.accessToken;
  }
  if (user.linkedin_token_expires_at <= now()) {
    throw new LinkedInError("Your LinkedIn connection expired. Reconnect your account in Settings.", 401);
  }
  return decrypt(user.linkedin_token_enc);
}

export async function setAnthropicKey(userId: number, key: string | null): Promise<void> {
  await run("UPDATE users SET anthropic_key_enc = ? WHERE id = ?", [key ? encrypt(key) : null, userId]);
}

export function getAnthropicKey(user: UserRow): string | null {
  return user.anthropic_key_enc ? decrypt(user.anthropic_key_enc) : null;
}

export async function updateUserSettings(userId: number, settings: { model?: string; timezone?: string }): Promise<void> {
  if (settings.model !== undefined) await run("UPDATE users SET model = ? WHERE id = ?", [settings.model, userId]);
  if (settings.timezone !== undefined) await run("UPDATE users SET timezone = ? WHERE id = ?", [settings.timezone, userId]);
}

export async function getProfile(userId: number): Promise<Profile> {
  const row = await get<{ data: string }>("SELECT data FROM profiles WHERE user_id = ?", [userId]);
  return row ? (JSON.parse(row.data) as Profile) : {};
}

export async function saveProfile(userId: number, profile: Profile): Promise<void> {
  await run(
    `INSERT INTO profiles (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [userId, JSON.stringify(profile), now()],
  );
}
