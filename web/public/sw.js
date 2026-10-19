// Linkmein's service worker. Its only job is Android's "Share to Linkmein":
// the share sheet POSTs the shared screenshots here, they are parked in
// Cache Storage, and the Remix page picks them up. Every other request goes
// straight to the network as if there were no service worker.
const SHARE_CACHE = "linkmein-share";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") event.respondWith(receiveShare(event.request));
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) await cache.delete(key);
    const files = form.getAll("screenshots").filter((f) => f instanceof File && f.type.startsWith("image/"));
    await Promise.all(
      files.map((file, i) =>
        cache.put(
          `/shared/file-${i}`,
          new Response(file, {
            headers: { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name || `screenshot-${i + 1}.jpg`), "X-Last-Modified": String(file.lastModified || Date.now()) },
          }),
        ),
      ),
    );
    const meta = { title: form.get("title") || "", text: form.get("text") || "", url: form.get("url") || "", count: files.length };
    await cache.put("/shared/meta", new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
    return Response.redirect("/remix?shared=1", 303);
  } catch {
    return Response.redirect("/remix?shared=failed", 303);
  }
}
