// Guide's Choice — PWA service worker
//
// GUARDRAIL (do not weaken): this app's trust principle is that data shown
// to the user is real and current — never a stale fact presented as fresh.
// That rule applies here too. This worker ONLY caches static, content-hashed
// build assets (JS/CSS/icons/fonts) so repeat loads are fast and the app
// shell works offline. It NEVER caches planner reports, gauge readings,
// weather, auth, or any Supabase/API call — those always hit the network.

const STATIC_CACHE = "gc-static-v1";
const STATIC_ASSET_PATTERN = /\.(js|css|png|jpg|jpeg|svg|woff2?|ico)$/;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only ever handle GET requests. Everything else (POST/PUT/DELETE — all
  // of Supabase writes, the Claude proxy, etc.) passes straight to network.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cross-origin requests (Supabase, USGS, Open-Meteo, Google Places, Google
  // Fonts, the Anthropic proxy's outbound calls, etc.) and anything under
  // /api/ are live data or auth — never intercept, always network.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  // HTML navigations: network-first, so a user always gets the current
  // shell (which references the current, correctly content-hashed JS/CSS).
  // Falls back to a cached shell only if fully offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Static, content-hashed build assets + icons/fonts: cache-first.
  // Safe indefinitely — Vite gives changed content a new hashed filename,
  // so a stale cache entry is never served for code that has actually changed.
  if (STATIC_ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // Anything else same-origin and not matched above: pass through untouched.
});
