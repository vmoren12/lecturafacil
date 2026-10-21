/* Service worker: network first, cache as a fallback, so the app keeps
   working without connection after the first visit. */

const CACHE = "lecturafacil-v4";
const SHELL = [
  "./", "index.html", "css/app.css", "manifest.webmanifest", "icons/icon.svg",
  "js/main.js", "js/reader.js", "js/books.js", "js/importers.js", "js/text.js",
  "js/translate.js", "js/languages.js", "js/store.js", "js/speech.js", "js/ui.js",
  "js/aiprompt.js", "js/aidialog.js",
  "data/library.json", "data/books/illa-del-tresor-mostra.json"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || Response.error()))
  );
});
