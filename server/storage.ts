import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { del, get, head, issueSignedToken, presignUrl, type IssuedSignedToken } from "@vercel/blob";
import { config } from "./config.js";

// Uploaded files live under keys like "u/<userId>/<uuid>/<name>", either on local
// disk (self-hosted) or in a private Vercel Blob store. The browser uploads directly
// to storage; the server only ever reads, signs and deletes.

const KEY = /^u\/(\d+)\/[A-Za-z0-9-]{8,64}\/[A-Za-z0-9._-]{1,80}$/;

/** True if `key` is a well-formed storage key belonging to this user. */
export function ownsKey(userId: number, key: string): boolean {
  const m = KEY.exec(key);
  return Boolean(m && Number(m[1]) === userId && !key.includes(".."));
}

function localPath(key: string): string {
  if (!KEY.test(key)) throw new Error(`Invalid storage key: ${key}`);
  return path.join(config.uploadDir, ...key.split("/"));
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
  const res = await get(key, { access: "private" });
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

/** Local: the file path to stream. Blob: a short-lived signed URL to redirect to. */
export async function locate(key: string): Promise<{ file: string } | { url: string }> {
  return config.storage === "local" ? { file: localPath(key) } : { url: await signedUrl(key) };
}
