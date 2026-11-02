// Keeps the tool working offline. Own files only: GitHub's API is never cached.
// Serves the saved copy at once and fetches a fresher one for next time.
const CACHE = "suratan-10";
const FILES = [
  "./", "index.html", "style.css", "app.js", "parse.js", "graph.js", "github.js", "sample.js",
  "check-worker.js", "ink-guard.js", "vendor/ink-full.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const saved = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request).then(res => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      });
      if (saved) { fresh.catch(() => {}); return saved; }
      return fresh;
    })
  );
});
