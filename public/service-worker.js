// Guide's Choice — PWA service worker
//
// GUARDRAIL (do not weaken): this app's trust principle is that data shown
// to the user is real and current — never a stale fact presented as fresh.
// That rule applies here too. This worker ONLY caches static build assets
// (content-hashed JS/CSS cache-first; fixed-filename icons stale-while-
// revalidate — see patterns below) so repeat loads are fast and the app
// shell works offline. It NEVER caches planner reports, gauge readings,
// weather, auth, or any Supabase/API call — those always hit the network.

const STATIC_CACHE = "gc-static-v2"; // bumped v1->v2: forces every device to drop
// whatever it had cached under the old bucket (see REVALIDATE note below for why).

// Vite content-hashes these filenames (name-HASH.js/name-HASH.css under /assets/) —
// a changed file always ships under a brand-new URL, so caching it forever is safe.
const HASHED_ASSET_PATTERN = /\/assets\/.+\.(js|css)$/;

// Brand/icon files in /public (favicon.png, logo-mark.png, icon-192.png, etc. — see
// manifest.json/index.html) keep a FIXED filename across deploys. Under pure
// cache-first, once a device cached one of these it would NEVER see an update no
// matter how many times the file changes on the server (this is what caused the
// logo to update on one device but not another after a rebrand). These get
// stale-while-revalidate instead: serve the cached copy immediately if present,
// but always kick off a background fetch to refresh the cache for next time.
const REVALIDATE_ASSET_PATTERN = /\.(png|jpg|jpeg|svg|woff2?|ico)$/;

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

  // Content-hashed JS/CSS build output: cache-first, safe indefinitely — a
  // changed file always ships under a new hashed filename.
  if (HASHED_ASSET_PATTERN.test(url.pathname)) {
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

  // Fixed-filename brand/icon assets: stale-while-revalidate. Serve the cached
  // copy instantly if we have one (fast, works offline), but always fetch a
  // fresh copy in the background and update the cache — so a server-side change
  // (e.g. a rebrand) reaches every device within one extra load instead of
  // getting stuck forever.
  if (REVALIDATE_ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req)
            .then((res) => {
              if (res.ok) cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // Anything else same-origin and not matched above: pass through untouched.
});
