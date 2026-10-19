import { db, type StoredMedia } from "./db";

// Your data lives on this device, so a backup file is how you move it to a new
// phone or protect it from "clear browsing data". Your Claude key is left out.

const VERSION = 1;

async function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fromDataUrl(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}

type SerializedMedia = Omit<StoredMedia, "blob" | "preview" | "frames"> & { blob: string; preview: string | null; frames: string[] };

export async function exportBackup(): Promise<Blob> {
  const d = await db();
  const media: SerializedMedia[] = [];
  for (const m of await d.getAll("media")) {
    media.push({ ...m, blob: await toDataUrl(m.blob), preview: m.preview ? await toDataUrl(m.preview) : null, frames: await Promise.all(m.frames.map(toDataUrl)) });
  }
  const settings = (await d.get("kv", "settings")) as { model?: string } | undefined;
  const backup = {
    app: "linkmein",
    version: VERSION,
    exportedAt: new Date().toISOString(),
    profile: (await d.get("kv", "profile")) ?? {},
    settings: { model: settings?.model },
    posts: await d.getAll("posts"),
    inspirations: await d.getAll("inspirations"),
    media,
  };
  return new Blob([JSON.stringify(backup)], { type: "application/json" });
}

/** Replaces everything on this device (except your Claude key) with the backup's contents. */
export async function importBackup(file: File): Promise<{ posts: number; media: number }> {
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't a Linkmein backup.");
  }
  if (backup?.app !== "linkmein" || backup.version !== VERSION) throw new Error("That file isn't a Linkmein backup.");
  const media: StoredMedia[] = [];
  for (const m of backup.media as SerializedMedia[]) {
    media.push({ ...m, blob: await fromDataUrl(m.blob), preview: m.preview ? await fromDataUrl(m.preview) : null, frames: await Promise.all(m.frames.map(fromDataUrl)) });
  }
  const d = await db();
  const tx = d.transaction(["kv", "posts", "inspirations", "media"], "readwrite");
  const settings = ((await tx.objectStore("kv").get("settings")) as Record<string, unknown> | undefined) ?? {};
  await Promise.all([tx.objectStore("posts").clear(), tx.objectStore("inspirations").clear(), tx.objectStore("media").clear()]);
  await tx.objectStore("kv").put(backup.profile ?? {}, "profile");
  if (backup.settings?.model) await tx.objectStore("kv").put({ ...settings, model: backup.settings.model }, "settings");
  for (const p of backup.posts) await tx.objectStore("posts").put(p);
  for (const i of backup.inspirations) await tx.objectStore("inspirations").put(i);
  for (const m of media) await tx.objectStore("media").put(m);
  await tx.done;
  return { posts: backup.posts.length, media: media.length };
}
