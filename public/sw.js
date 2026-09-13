/* Mailbox Service Worker：离线壳 + 静态资源缓存。邮件数据始终走网络，不做离线缓存。 */
const VERSION = "mailbox-v1";
const SHELL = ["/offline", "/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API / 事件流不缓存
  if (url.pathname.startsWith("/api/")) return;

  // 静态资源：缓存优先
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // 页面导航：网络优先，离线时给离线页
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline").then((hit) => hit || Response.error())));
  }
});
