const CACHE_NAME = 'polinasyon-cache-v1';
const assetsToCache = [
  './',
  './index.html',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest'
];

// Yükleme aşamasında dosyaları önbelleğe al
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
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clientsClaim();
});

// İstekleri yakala (Önce cache, yoksa ağ)
self.addEventListener('fetch', (event) => {
  // Harici API isteklerini (Open-Meteo, RSS vb.) es geç, direkt internetten dene
  if (event.request.url.includes('api.open-meteo.com') || event.request.url.includes('rss2json.com') || event.request.url.includes('bigdatacloud.net')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).catch(() => {
        // İsteğe bağlı: İnternet yoksa ve sayfa bulunamadıysa yedek bir html dönebilirsin
      });
    })
  );
});
