// Campfire Service Worker — caching + push notifications
const CACHE_NAME = "campfire-v1";

// Assets to pre-cache on install (shell resources)
const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

// Install: pre-cache shell resources
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API/WS, cache-first for static assets
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests and WebSocket upgrades
  if (event.request.method !== "GET") return;
  // Skip API requests — always go to network
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Return cached version while fetching update in background (stale-while-revalidate)
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          // Only cache successful responses for same-origin requests
          if (networkResponse.ok && url.origin === self.location.origin) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Network failed — return cached if available
          return cached || new Response("Offline", { status: 503 });
        });

      return cached || fetchPromise;
    })
  );
});

// Push notifications for permission requests
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Campfire", body: event.data.text() };
  }

  const title = payload.title || "Campfire";
  const options = {
    body: payload.body || "Permission request pending",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.tag || "campfire-notification",
    data: payload.data || {},
    actions: payload.actions || [
      { action: "allow", title: "Allow" },
      { action: "deny", title: "Deny" },
    ],
    vibrate: [200, 100, 200],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Handle notification click — focus the app or open it
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus existing window if available
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          return client.focus();
        }
      }
      // Otherwise open new window
      return self.clients.openWindow("/");
    })
  );
});
