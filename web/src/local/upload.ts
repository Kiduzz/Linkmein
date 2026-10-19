import { upload as blobUpload } from "@vercel/blob/client";
import type { AppConfig } from "../api";

/** Sends a file to the server's storage so it can be published later, even with the phone off. */
export async function uploadToServer(config: AppConfig, key: string, body: Blob): Promise<void> {
  if (config.storage === "blob") {
    await blobUpload(key, body, {
      access: "private",
      handleUploadUrl: "/api/blob/upload",
      headers: { "X-Linkmein": "1" },
      contentType: body.type || "application/octet-stream",
      multipart: body.size > 100 * 1024 * 1024,
    });
    return;
  }
  const res = await fetch(`/api/uploads/${key}`, {
    method: "PUT",
    headers: { "X-Linkmein": "1", "Content-Type": body.type || "application/octet-stream" },
    body,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Upload failed (${res.status})`);
}

export function extension(file: Blob, fallback: string): string {
  const fromType = file.type.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg").replace("quicktime", "mov").replace("x-m4a", "m4a");
  return (fromType && /^[a-z0-9]{2,5}$/.test(fromType) ? fromType : fallback).toLowerCase();
}
