import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { BlobPreconditionFailedError, del, get, head, issueSignedToken, presignUrl, put, type IssuedSignedToken } from "@vercel/blob";
import { config } from "./config.js";

// The server keeps very little: LinkedIn connections, the publish queue, and the
// files of posts waiting to go out. It lives on local disk (self-hosted) or in a
// private Vercel Blob store. Everything else stays on the user's phone.

const SEGMENT = /^[A-Za-z0-9._-]{1,80}$/;
const UPLOAD_KEY = /^u\/([a-f0-9]{24})\/[A-Za-z0-9-]{8,64}\/[A-Za-z0-9._-]{1,80}$/;

/** True if `key` is a well-formed upload key in this account's folder. */
export function ownsKey(accountKey: string, key: string): boolean {
  const m = UPLOAD_KEY.exec(key);
  return Boolean(m && m[1] === accountKey && !key.includes(".."));
}

function localPath(key: string): string {
  const parts = key.split("/");
  if (!parts.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")) throw new Error(`Invalid storage key: ${key}`);
  return path.join(config.storageDir, ...parts);
}

export class TooLargeError extends Error {}

/** Local mode only: streams an upload from the browser to disk. */
export async function writeLocal(key: string, body: Readable, maxBytes: number): Promise<number> {
  const file = localPath(key);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let size = 0;
  try {
    await pipeline(
      body,
      async function* (source) {
        for await (const chunk of source as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > maxBytes) throw new TooLargeError(`Files are limited to ${Math.round(maxBytes / 1024 / 1024)} MB.`);
          yield chunk;
        }
      },
      fs.createWriteStream(file, { flags: "wx" }),
    );
  } catch (err) {
    await fsp.rm(file, { force: true });
    throw err;
  }
  return size;
}

/** Size in bytes, or null if the file doesn't exist. */
export async function sizeOf(key: string): Promise<number | null> {
  if (config.storage === "local") {
    const stat = await fsp.stat(localPath(key)).catch(() => null);
    return stat?.size ?? null;
  }
  const meta = await head(key).catch(() => null);
  return meta?.size ?? null;
}

export async function readFile(key: string): Promise<Buffer> {
  if (config.storage === "local") return fsp.readFile(localPath(key));
  const res = await get(key, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200) throw new Error(`File not found in storage: ${key}`);
  return Buffer.from(await new Response(res.stream).arrayBuffer());
}

/** Reads bytes [start, end] inclusive. Used to upload big videos to LinkedIn in parts. */
export async function readRange(key: string, start: number, end: number): Promise<Buffer> {
  if (config.storage === "local") {
    const handle = await fsp.open(localPath(key), "r");
    try {
      const buf = Buffer.alloc(end - start + 1);
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  const res = await fetch(await signedUrl(key), { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`Reading ${key} from storage failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A server that ignores Range sends the whole file.
  return res.status === 200 ? buf.subarray(start, end + 1) : buf;
}

export async function deleteFiles(keys: string[]): Promise<void> {
  if (!keys.length) return;
  if (config.storage === "local") {
    await Promise.all(keys.map((k) => fsp.rm(localPath(k), { force: true })));
    await Promise.all([...new Set(keys.map((k) => path.dirname(localPath(k))))].map((d) => fsp.rmdir(d).catch(() => undefined)));
    return;
  }
  await del(keys);
}

// --- JSON records with optimistic concurrency ------------------------------------

export interface Versioned<T> {
  value: T;
  etag: string;
}

const sha = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

// Local mode runs in one process, so a per-key lock makes compare-and-swap safe.
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(key, next.catch(() => undefined));
  return next;
}

/**
 * Reads a JSON record. `fresh` bypasses the CDN cache: use it before any
 * read-modify-write. Cached reads are free on Vercel Blob's quota but may be up
 * to a minute stale.
 */
export async function readJson<T>(key: string, { fresh = false } = {}): Promise<Versioned<T> | null> {
  if (config.storage === "local") {
    const text = await fsp.readFile(localPath(key), "utf8").catch(() => null);
    return text === null ? null : { value: JSON.parse(text) as T, etag: sha(text) };
  }
  const res = await get(key, { access: "private", useCache: !fresh });
  if (!res || res.statusCode !== 200) return null;
  return { value: JSON.parse(await new Response(res.stream).text()) as T, etag: res.blob.etag };
}

/**
 * Writes a JSON record. With `ifMatch` the write only succeeds if the record is
 * unchanged since that read; with `create` only if it doesn't exist yet.
 * Returns the new etag, or null when the condition failed.
 */
export async function writeJson(key: string, value: unknown, cond: { ifMatch?: string; create?: boolean } = {}): Promise<string | null> {
  const text = JSON.stringify(value);
  if (config.storage === "local") {
    return withLock(key, async () => {
      const file = localPath(key);
      const current = await fsp.readFile(file, "utf8").catch(() => null);
      if (cond.create && current !== null) return null;
      if (cond.ifMatch && (current === null || sha(current) !== cond.ifMatch)) return null;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      await fsp.writeFile(tmp, text);
      await fsp.rename(tmp, file);
      return sha(text);
    });
  }
  try {
    const result = await put(key, text, {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: !cond.create,
      ifMatch: cond.ifMatch,
      cacheControlMaxAge: 3600,
    });
    return result.etag;
  } catch (err) {
    if (err instanceof BlobPreconditionFailedError) return null;
    if (cond.create && /already exists/i.test((err as Error).message)) return null;
    throw err;
  }
}

/** Read-modify-write that retries when someone else changed the record in between. */
export async function updateJson<T>(key: string, initial: T, change: (current: T) => T): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await readJson<T>(key, { fresh: true });
    const next = change(current ? current.value : structuredClone(initial));
    const ok = await writeJson(key, next, current ? { ifMatch: current.etag } : { create: true });
    if (ok) return next;
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
  }
  throw new Error(`Couldn't update ${key}: too many concurrent changes`);
}

// One read-only delegation for the whole store, reused for an hour. Signing a URL for
// a single file is then a local HMAC, and access control happens in our own routes.
let delegation: IssuedSignedToken | null = null;

async function signedUrl(key: string): Promise<string> {
  if (!delegation || delegation.validUntil - Date.now() < 10 * 60_000) {
    delegation = await issueSignedToken({ pathname: "*", operations: ["get"], validUntil: Date.now() + 60 * 60_000 });
  }
  const { presignedUrl } = await presignUrl(delegation, { operation: "get", pathname: key, access: "private" });
  return presignedUrl;
}
