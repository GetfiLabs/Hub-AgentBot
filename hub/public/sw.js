const CACHE_NAME = "getfi-hub-v1";

const PRECACHE_URLS = ["/", "/dashboard", "/earn", "/my-games", "/wallet", "/profile"];

const BYPASS_HOSTS = [
  "googleapis.com",
  "google.com",
  "gstatic.com",
  "firebaseio.com",
  "firebaseapp.com",
  "firebasestorage.googleapis.com",
  "securetoken.googleapis.com",
  "identitytoolkit.googleapis.com",
];

function shouldBypass(url) {
  return BYPASS_HOSTS.some(function (host) {
    return url.hostname.includes(host);
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) {
            return k !== CACHE_NAME;
          })
          .map(function (k) {
            return caches.delete(k);
          }),
      );
    }),
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  var url;

  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  // Skip non-http(s) schemes (chrome-extension://, moz-extension://, etc.)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return;
  }

  // Never intercept Google / Firebase requests — pass straight to network
  if (event.request.method !== "GET" || shouldBypass(url)) {
    return;
  }

  // Only cache same-origin navigation and static asset requests
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var fetched = fetch(event.request).then(function (response) {
        if (response && response.status === 200 && response.type === "basic") {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            return cache.put(event.request, clone);
          });
        }
        return response;
      });
      return cached || fetched;
    }),
  );
});
