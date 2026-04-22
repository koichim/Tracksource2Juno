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

/**
 * v169: 200 OK のレスポンスから Range リクエストに応じた 206 Partial Content を生成する
 */
async function getRangeResponse(request, response) {
  const rangeHeader = request.headers.get('Range');
  if (!rangeHeader) return response;

  const bytes = rangeHeader.match(/^bytes=(\d+)-(\d+)?$/);
  if (!bytes) return response;

  try {
    const blob = await response.blob();
    const start = parseInt(bytes[1], 10);
    const end = bytes[2] ? parseInt(bytes[2], 10) : blob.size - 1;

    if (start >= blob.size) {
      return new Response('', {
        status: 416,
        headers: { 'Content-Range': `bytes */${blob.size}` }
      });
    }

    const slicedBlob = blob.slice(start, end + 1);
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Content-Range', `bytes ${start}-${end}/${blob.size}`);
    newHeaders.set('Content-Length', slicedBlob.size);
    newHeaders.set('Accept-Ranges', 'bytes');

    return new Response(slicedBlob, {
      status: 206,
      statusText: 'Partial Content',
      headers: newHeaders
    });
  } catch (err) {
    console.error('[SW] Range generation failed:', err);
    return response;
  }
}

/**
 * キャッシュのアイテム数が上限を超えた場合、古いものから削除する
 */
async function pruneCache(cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      // 挿入順（古い順）に取得される前提で削除
      const keysToDelete = keys.slice(0, keys.length - maxItems);
      await Promise.all(keysToDelete.map(key => cache.delete(key)));
      console.log(`[SW] Pruned ${keysToDelete.length} old tracks from ${cacheName}`);
    }
  } catch (err) {
    console.error('[SW] Cache prune error:', err);
  }
}

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

  // v150/154/160: ストリーミング・プロキシのハンドリング (キャッシュ優先方式)
  if (event.request.url.includes('/proxy-stream')) {
    const url = new URL(event.request.url);
    const fileId = url.searchParams.get('fileId');
    const token = url.searchParams.get('token');

    if (fileId && token) {
      const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      const rangeHeader = event.request.headers.get('Range');
      
      event.respondWith((async () => {
        // v160: まずは 'jukebox-downloads' キャッシュを確認
        const cache = await caches.open('jukebox-downloads');
        const cachedResponse = await cache.match(driveUrl);
        
        if (cachedResponse) {
          console.log('[SW] Serving from cache:', fileId);
          // v169: Cache API からの 200 OK をそのまま返すとブラウザが duration を Infinity と
          // 誤認してシークできない場合があるため、明示的に 206 Partial Content に変換する
          return await getRangeResponse(event.request, cachedResponse);
        }

        // キャッシュになければ通常通り Fetch
        const fetchHeaders = { 'Authorization': `Bearer ${token}` };
        if (rangeHeader) fetchHeaders['Range'] = rangeHeader;

        try {
          const response = await fetch(driveUrl, { headers: fetchHeaders });
          // 注意: ここで cache.put しない（巨大なため、明示的なプリフェッチ時のみに限定）
          return response;
        } catch (err) {
          console.error('[SW] Stream Proxy Fetch Error:', err);
          return new Response('Stream Proxy Error', { status: 500 });
        }
      })());
      return;
    }
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
          
          // キャッシュが肥大化しないように最大5曲（約50MB）に制限
          await pruneCache('jukebox-downloads', 5);
          
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
