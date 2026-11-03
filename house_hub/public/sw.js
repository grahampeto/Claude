// Service worker: lets the app open with no signal and makes it installable on
// Android. App files are fetched network-first (so updates show up straight
// away) with the cached copy as a fallback. Firebase, calendar feeds and
// cameras are other origins and are never touched.
var CACHE = 'house-hub-v14';
var FILES = ['./', 'index.html', 'app.css', 'app.js', 'ics.js', 'manifest.webmanifest', 'qrcode.js', 'icon.png', 'icon-192.png', 'icon-512.png',
  'icons/calendar.svg', 'icons/groceries.svg', 'icons/todo.svg', 'icons/cameras.svg', 'icons/settings.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); })); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // cache: 'no-cache' makes the browser check with GitHub Pages every time
  // (cheap, via ETag) instead of reusing a copy for up to 10 minutes.
  e.respondWith(fetch(req, { cache: 'no-cache' }).then(function (res) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); });
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match('index.html'); });
  }));
});
