'use strict';
// Relative URLs preserve the existing GitHub Pages project path and QR links.
var CACHE = 'apron-personal-v14-one-photo-20261105';
var FILES = ['./', './index.html', './assets/app.css?v=14', './assets/core.js?v=14', './assets/room.js?v=14', './assets/qr.js?v=14', './assets/checks.js?v=14', './assets/app.js?v=14', './assets/documents.js?v=14', './assets/test-tomato.jpg', './fonts/onest-400.ttf', './fonts/onest-500.ttf', './fonts/onest-600.ttf'];
self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(FILES.map(function (file) { return new Request(new URL(file, self.location.href).href, { cache: 'reload' }); })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) { return Promise.all(names.filter(function (name) { return name.startsWith('apron-personal-') && name !== CACHE; }).map(function (name) { return caches.delete(name); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (event) {
  var request = event.request, url = new URL(request.url);
  // Never cache submitted images or calls to the future model relay.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Only the app's own files: room sync streams and attachments of the local server pass straight through.
  var known = FILES.some(function (file) { return new URL(file, self.location.href).href === url.href; });
  if (request.mode !== 'navigate' && !known) return;
  var key = request.mode === 'navigate' ? new URL('./index.html', self.location.href).href : request;
  event.respondWith(fetch(request, { cache: 'no-store' }).then(function (response) {
    if (response.ok) {
      var copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.put(key, copy); }));
    }
    return response;
  }).catch(function () { return caches.open(CACHE).then(function (cache) { return cache.match(key); }).then(function (response) { return response || new Response('Нет соединения. Откройте Apron с интернетом один раз перед показом.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }); }));
});
