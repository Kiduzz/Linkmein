// Screenshots shared to Linkmein from Android's share sheet. The service
// worker (public/sw.js) parks them in Cache Storage; Remix takes them out.

const SHARE_CACHE = "linkmein-share";

export interface SharedPost {
  files: File[];
  /** A link that came with the share, kept only as a reference. */
  url: string;
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}

let taking: Promise<SharedPost | null> | null = null;

/** Returns what was last shared to Linkmein, once, or null if nothing is waiting. */
export function takeSharedPost(): Promise<SharedPost | null> {
  // React's StrictMode runs effects twice; both calls share one read.
  taking ??= readShare().finally(() => setTimeout(() => (taking = null), 1000));
  return taking;
}

async function readShare(): Promise<SharedPost | null> {
  if (!("caches" in window) || !(await caches.has(SHARE_CACHE))) return null;
  const cache = await caches.open(SHARE_CACHE);
  const files: File[] = [];
  let url = "";
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    if (!res) continue;
    if (new URL(req.url).pathname === "/shared/meta") {
      const meta = (await res.json()) as { title: string; text: string; url: string };
      url = meta.url || findLink(meta.text) || "";
    } else {
      const name = decodeURIComponent(res.headers.get("X-File-Name") ?? "screenshot.jpg");
      files.push(new File([await res.blob()], name, { type: res.headers.get("Content-Type") ?? "image/jpeg", lastModified: Number(res.headers.get("X-Last-Modified")) || Date.now() }));
    }
  }
  await caches.delete(SHARE_CACHE);
  if (!files.length && !url) return null;
  return { files: files.sort((a, b) => a.lastModified - b.lastModified), url };
}

/** Apps often share a link inside the text ("Check out this post: https://…"). */
function findLink(text: string): string | null {
  return text.match(/https?:\/\/\S+/)?.[0] ?? null;
}
