const CACHE_NAME = 'jukebox-v2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './jukebox.js',
  './manifest.json',
  './icon-192x192.png',
  './icon-512x512.png',
  'https://cdn.jsdelivr.net/npm/amplitudejs@5.3.2/dist/amplitude.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js',
  'https://apis.google.com/js/api.js',
  'https://accounts.google.com/gsi/client'
];

self.addEventListener('install', event => {
  self.skipWaiting(); // 新しいSWをすぐに待機状態からアクティブにする
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    clients.claim(), // ページのリロードなしで即座に制御を開始する
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      );
    })
  );
});

self.addEventListener('fetch', event => {
  // Google API calls or Media files should not be cached by SW basic logic usually
  // But for the app shell, we want to serve from cache if offline
  if (event.request.url.includes('googleapis.com') || event.request.url.includes('google.com')) {
    return; // Let browser handle it
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        return response || fetch(event.request);
      })
  );
});
