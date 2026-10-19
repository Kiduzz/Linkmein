import { db, now, type UserRow } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { LinkedInError, refreshAccessToken, type LinkedInUser, type TokenSet } from "./linkedin.js";
import type { Profile } from "../shared/types.js";
import { config } from "./config.js";

export function getUser(id: number): UserRow | undefined {
  return db().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function upsertLinkedInUser(info: LinkedInUser, tokens: TokenSet | null): UserRow {
  const existing = db().prepare("SELECT * FROM users WHERE linkedin_sub = ?").get(info.sub) as UserRow | undefined;
  const tokenFields = tokens
    ? {
        linkedin_token_enc: encrypt(tokens.accessToken),
        linkedin_token_expires_at: tokens.expiresAt,
        linkedin_refresh_enc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
        linkedin_refresh_expires_at: tokens.refreshExpiresAt,
      }
    : null;

  if (existing) {
    db()
      .prepare("UPDATE users SET name = ?, email = ?, picture = ? WHERE id = ?")
      .run(info.name, info.email, info.picture, existing.id);
    if (tokenFields) saveTokenFields(existing.id, tokenFields);
    return getUser(existing.id)!;
  }

  const result = db()
    .prepare(
      `INSERT INTO users (linkedin_sub, name, email, picture, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(info.sub, info.name, info.email, info.picture, config.ai.defaultModel, now());
  const id = Number(result.lastInsertRowid);
  if (tokenFields) saveTokenFields(id, tokenFields);
  return getUser(id)!;
}

function saveTokenFields(
  userId: number,
  f: {
    linkedin_token_enc: string;
    linkedin_token_expires_at: number;
    linkedin_refresh_enc: string | null;
    linkedin_refresh_expires_at: number | null;
  },
) {
  db()
    .prepare(
      `UPDATE users SET linkedin_token_enc = ?, linkedin_token_expires_at = ?,
         linkedin_refresh_enc = COALESCE(?, linkedin_refresh_enc),
         linkedin_refresh_expires_at = COALESCE(?, linkedin_refresh_expires_at)
       WHERE id = ?`,
    )
    .run(f.linkedin_token_enc, f.linkedin_token_expires_at, f.linkedin_refresh_enc, f.linkedin_refresh_expires_at, userId);
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
    saveTokenFields(user.id, {
      linkedin_token_enc: encrypt(tokens.accessToken),
      linkedin_token_expires_at: tokens.expiresAt,
      linkedin_refresh_enc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      linkedin_refresh_expires_at: tokens.refreshExpiresAt,
    });
    return tokens.accessToken;
  }
  if (user.linkedin_token_expires_at <= now()) {
    throw new LinkedInError("Your LinkedIn connection expired. Reconnect your account in Settings.", 401);
  }
  return decrypt(user.linkedin_token_enc);
}

export function setAnthropicKey(userId: number, key: string | null): void {
  db().prepare("UPDATE users SET anthropic_key_enc = ? WHERE id = ?").run(key ? encrypt(key) : null, userId);
}

export function getAnthropicKey(user: UserRow): string | null {
  return user.anthropic_key_enc ? decrypt(user.anthropic_key_enc) : null;
}

export function updateUserSettings(userId: number, settings: { model?: string; timezone?: string }): void {
  if (settings.model !== undefined) db().prepare("UPDATE users SET model = ? WHERE id = ?").run(settings.model, userId);
  if (settings.timezone !== undefined) db().prepare("UPDATE users SET timezone = ? WHERE id = ?").run(settings.timezone, userId);
}

export function getProfile(userId: number): Profile {
  const row = db().prepare("SELECT data FROM profiles WHERE user_id = ?").get(userId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Profile) : {};
}

export function saveProfile(userId: number, profile: Profile): void {
  db()
    .prepare(
      `INSERT INTO profiles (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    )
    .run(userId, JSON.stringify(profile), now());
}
