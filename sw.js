const CACHE_NAME = 'polinasyon-cache-v2';
const DYNAMIC_CACHE = 'polinasyon-dynamic-v2';

const assetsToCache = [
  './',
  './index.html',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest'
];

// Yükleme aşamasında temel statik dosyaları önbelleğe al
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(assetsToCache);
    })
  );
  self.skipWaiting();
});

// Etkinleştirme aşaması ve eski cache temizliği
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== DYNAMIC_CACHE) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clientsClaim();
});

// İstekleri Yakalama Stratejisi
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Hava durumu veya dinamik API istekleri için Network-First (Önce Ağ, Başarısız olursa Cache)
  if (url.includes('api.open-meteo.com') || url.includes('rss2json.com') || url.includes('bigdatacloud.net')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(DYNAMIC_CACHE).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // İnternet yoksa en son önbelleğe alınan hava durumu / API verisini getir
          return caches.match(event.request);
        })
    );
    return;
  }

  // Statik dosyalar için Stale-While-Revalidate (Hızlı yükleme için önce cache, sonra arka planda güncelleme)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse.clone());
            });
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

