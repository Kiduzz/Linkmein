import Database from "better-sqlite3";
import { config } from "./config.js";

export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed";
export type MediaKind = "image" | "audio" | "video";
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
  path: string;
  status: MediaStatus;
  error: string | null;
  transcript: string | null;
  /** JSON array of absolute paths to extracted video frames. */
  frames: string | null;
  /** JPEG resized for Claude's vision input (images) or the video poster frame. */
  preview_path: string | null;
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

const migrations: string[] = [
  `
  CREATE TABLE users (
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
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE media (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    transcript TEXT,
    frames TEXT,
    preview_path TEXT,
    duration_s REAL,
    width INTEGER,
    height INTEGER,
    alt_text TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX media_user ON media(user_id, created_at DESC);
  CREATE TABLE inspirations (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_text TEXT NOT NULL,
    source_author TEXT,
    source_url TEXT,
    image_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
    analysis TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE posts (
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
  CREATE INDEX posts_user ON posts(user_id, updated_at DESC);
  CREATE INDEX posts_due ON posts(status, scheduled_at);
  `,
];

export function openDatabase(file = config.dbPath): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let i = version; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return db;
}

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (!instance) instance = openDatabase();
  return instance;
}

/** Tests swap in an in-memory database. */
export function setDatabase(database: Database.Database): void {
  instance = database;
}

export const now = () => Date.now();
