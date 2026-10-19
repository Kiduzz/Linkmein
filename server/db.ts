import fs from "node:fs";
import path from "node:path";
import { createClient, type Client, type InArgs } from "@libsql/client";
import { config } from "./config.js";

// SQLite everywhere: a local file when self-hosted, Turso (hosted libSQL) on Vercel.

export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed";
export type MediaKind = "image" | "audio" | "video";
/** "processing" means the browser hasn't finished transcribing it yet. */
export type MediaStatus = "processing" | "ready" | "failed";

export interface UserRow {
  id: number;
  linkedin_sub: string;
  name: string;
  email: string | null;
  picture: string | null;
  linkedin_token_enc: string | null;
  linkedin_token_expires_at: number | null;
  linkedin_refresh_enc: string | null;
  linkedin_refresh_expires_at: number | null;
  anthropic_key_enc: string | null;
  model: string | null;
  timezone: string | null;
  created_at: number;
}

export interface MediaRow {
  id: number;
  user_id: number;
  kind: MediaKind;
  original_name: string;
  mime: string;
  size: number;
  /** Storage key of the file that gets published to LinkedIn. */
  file_key: string;
  status: MediaStatus;
  error: string | null;
  transcript: string | null;
  /** JSON array of storage keys for frames sampled from a video. */
  frame_keys: string | null;
  /** JPEG resized for Claude's vision input (images) or the video poster frame. */
  preview_key: string | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  alt_text: string | null;
  created_at: number;
}

export interface PostRow {
  id: number;
  user_id: number;
  text: string;
  /** JSON array of media ids. */
  media_ids: string;
  status: PostStatus;
  scheduled_at: number | null;
  published_at: number | null;
  linkedin_urn: string | null;
  attempts: number;
  last_error: string | null;
  visibility: "PUBLIC" | "CONNECTIONS";
  source: string | null;
  inspiration_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface InspirationRow {
  id: number;
  user_id: number;
  source_text: string;
  source_author: string | null;
  source_url: string | null;
  image_media_id: number | null;
  /** JSON from the analysis step. */
  analysis: string | null;
  created_at: number;
}

// Idempotent so two serverless instances cold-starting at once can't trip over each other.
const migrations: string[] = [
  `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    linkedin_sub TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT,
    picture TEXT,
    linkedin_token_enc TEXT,
    linkedin_token_expires_at INTEGER,
    linkedin_refresh_enc TEXT,
    linkedin_refresh_expires_at INTEGER,
    anthropic_key_enc TEXT,
    model TEXT,
    timezone TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    file_key TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    transcript TEXT,
    frame_keys TEXT,
    preview_key TEXT,
    duration_s REAL,
    width INTEGER,
    height INTEGER,
    alt_text TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS media_user ON media(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS inspirations (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_text TEXT NOT NULL,
    source_author TEXT,
    source_url TEXT,
    image_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
    analysis TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    media_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    scheduled_at INTEGER,
    published_at INTEGER,
    linkedin_urn TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    visibility TEXT NOT NULL DEFAULT 'PUBLIC',
    source TEXT,
    inspiration_id INTEGER REFERENCES inspirations(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS posts_user ON posts(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS posts_due ON posts(status, scheduled_at);
  `,
];

async function migrate(client: Client): Promise<void> {
  await client.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = (await client.execute("SELECT MAX(version) AS v FROM schema_version")).rows[0];
  const version = Number(row?.v ?? 0);
  for (let i = version; i < migrations.length; i++) {
    await client.executeMultiple(migrations[i]);
    await client.execute({ sql: "INSERT INTO schema_version (version) VALUES (?)", args: [i + 1] });
  }
}

let client: Client | null = null;
let ready: Promise<void> | null = null;

export function openDatabase(url = config.database.url, authToken = config.database.authToken): Client {
  if (url.startsWith("file:")) fs.mkdirSync(path.dirname(url.slice("file:".length)), { recursive: true });
  return createClient({ url, authToken, intMode: "number" });
}

/** Opens the database and runs migrations once per process. Await before any query. */
export function dbReady(): Promise<void> {
  if (!ready) {
    client ??= openDatabase();
    ready = (async () => {
      await client!.execute("PRAGMA foreign_keys = ON").catch(() => undefined);
      await migrate(client!);
    })();
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

/** Tests swap in an in-memory database. */
export async function setDatabase(c: Client): Promise<void> {
  client = c;
  ready = null;
  await dbReady();
}

function conn(): Client {
  if (!client) client = openDatabase();
  return client;
}

function toObjects<T>(result: { columns: string[]; rows: ArrayLike<unknown>[] }): T[] {
  return result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]])) as T);
}

export async function all<T>(sql: string, args: InArgs = []): Promise<T[]> {
  await dbReady();
  return toObjects<T>(await conn().execute({ sql, args }));
}

export async function get<T>(sql: string, args: InArgs = []): Promise<T | undefined> {
  return (await all<T>(sql, args))[0];
}

export async function run(sql: string, args: InArgs = []): Promise<{ changes: number; lastId: number }> {
  await dbReady();
  const result = await conn().execute({ sql, args });
  return { changes: result.rowsAffected, lastId: Number(result.lastInsertRowid ?? 0) };
}

export const now = () => Date.now();
