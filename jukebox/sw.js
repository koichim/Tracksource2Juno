const VERSION = new URL(self.location).searchParams.get('v') || 'v1';
const CACHE_NAME = 'jukebox-cache-' + VERSION;
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
            // Force a fresh fetch from the network to bypass browser HTTP cache
            const request = new Request(url, { cache: 'reload' });
            const response = await fetch(request);
            if (response.ok) {
              return await cache.put(url, response);
            }
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
  // v86: プロキシ通信は Service Worker を完全にバイパスさせる（最優先）
  if (event.request.url.includes('auth_proxy.cgi')) {
    return;
  }

  // Google API calls or Media files should not be cached by SW basic logic usually
  // But for the app shell, we want to serve from cache if offline
  if (event.request.url.includes('googleapis.com') || event.request.url.includes('google.com')) {
    return; // Let browser handle it
  }

  // v75: GETのみをキャッシュ対象とし、Google API等の外部ドメインやPOST通信を除外する
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
    return;
  }

  // Network-first strategy for app shell
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // もしネットワークが成功したらキャッシュに保存して返す
        if (response.status === 200) {
          const clonedResponse = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, clonedResponse);
          });
        }
        return response;
      })
      .catch(() => {
        // ネットワークが失敗（オフライン）ならキャッシュから返す
        return caches.match(event.request);
      })
  );
});

// v138: Service Worker への処理委譲 (DOWNLOAD_TRACK)
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'DOWNLOAD_TRACK') {
    const { url, fetchId, token } = event.data;
    
    // event.waitUntil を使うことで、非同期処理が終わるまで SW が終了するのを防ぐ
    event.waitUntil(async function() {
      try {
        console.log(`[SW] Starting delegated download: ${fetchId}`);
        // v139: CORS 回避のため、トークンをヘッダーに乗せる
        const response = await fetch(url, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (response.ok) {
          const cache = await caches.open('jukebox-downloads');
          await cache.put(url, response);
          
          // 完了をメインスレッドに通知
          const clients = await self.clients.matchAll();
          clients.forEach(client => {
            client.postMessage({
              type: 'DOWNLOAD_SUCCESS',
              fetchId: fetchId,
              url: url
            });
          });
          console.log(`[SW] Download success: ${fetchId}`);
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (err) {
        console.error(`[SW] Download failed: ${fetchId}`, err);
        const clients = await self.clients.matchAll();
        clients.forEach(client => {
          client.postMessage({
            type: 'DOWNLOAD_ERROR',
            fetchId: fetchId,
            status: err.message
          });
        });
      }
    }());
  }
});
