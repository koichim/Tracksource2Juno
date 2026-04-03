const CACHE_NAME = 'jukebox-cache-v61';
const ASSETS_TO_CACHE = [
  './jukebox.html',
  './jukebox.css',
  './jukebox.js',
  './manifest.json',
  './icon-192x192.png',
  './icon-512x512.png',
  'https://cdn.jsdelivr.net/npm/amplitudejs@5.3.2/dist/amplitude.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js'
];

self.addEventListener('install', event => {
  self.skipWaiting(); // 新しいSWをすぐに待機状態からアクティブにする
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        console.log('[SW] Pre-caching assets...');
        // addAllは1つでも失敗すると全体が失敗するため、1つずつ個別にキャッシュを試みる（安全策）
        const cachePromises = ASSETS_TO_CACHE.map(async (url) => {
          try {
            return await cache.add(url);
          } catch (error) {
            console.warn(`[SW] Failed to cache asset: ${url}`, error);
          }
        });
        return Promise.all(cachePromises);
      })
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

  // Network-first strategy for app shell
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // もしネットワークが成功したらキャッシュに保存して返す
        const clonedResponse = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, clonedResponse);
        });
        return response;
      })
      .catch(() => {
        // ネットワークが失敗（オフライン）ならキャッシュから返す
        return caches.match(event.request);
      })
  );
});
