import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Inspiration, Media, Post } from "../api";

// Everything personal lives here, in the browser's own database on this device:
// profile, Claude key, media library, saved posts, drafts and history.

export interface StoredMedia extends Media {
  /** The file that gets published (photos are re-encoded; audio/video as recorded). */
  blob: Blob;
  /** JPEG sized for Claude's vision input (photos) or the video poster frame. */
  preview: Blob | null;
  /** Frames sampled from a video, for Claude to look at. */
  frames: Blob[];
}

export interface StoredPost extends Post {
  /** The id of this post in the server's publish queue, once handed over. */
  queueId: string | null;
}

export interface LocalSettings {
  apiKey: string | null;
  model: string;
}

interface Schema extends DBSchema {
  kv: { key: string; value: unknown };
  media: { key: number; value: StoredMedia };
  posts: { key: number; value: StoredPost };
  inspirations: { key: number; value: Inspiration };
}

export type LocalDB = IDBPDatabase<Schema>;

let current: { account: string; db: Promise<LocalDB> } | null = null;

/** Opens this account's database. Each LinkedIn account on the device gets its own. */
export function openAccount(account: string): Promise<LocalDB> {
  if (current?.account !== account) {
    current = {
      account,
      db: openDB<Schema>(`linkmein-${account}`, 1, {
        upgrade(db) {
          db.createObjectStore("kv");
          db.createObjectStore("media", { keyPath: "id", autoIncrement: true });
          db.createObjectStore("posts", { keyPath: "id", autoIncrement: true });
          db.createObjectStore("inspirations", { keyPath: "id", autoIncrement: true });
        },
      }),
    };
    // Ask the browser not to evict this data when space runs low.
    void navigator.storage?.persist?.().catch(() => undefined);
  }
  return current.db;
}

export function db(): Promise<LocalDB> {
  if (!current) throw new Error("Not signed in");
  return current.db;
}

/** Adds a record and returns it with the id the database assigned. */
export async function addRecord<S extends "media" | "posts" | "inspirations">(
  store: S,
  value: Omit<Schema[S]["value"], "id">,
): Promise<Schema[S]["value"]> {
  const id = await (await db()).add(store, value as Schema[S]["value"]);
  return { ...value, id } as Schema[S]["value"];
}
