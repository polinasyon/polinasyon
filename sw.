const CACHE_NAME = 'polinasyon-static-v6';
const DYNAMIC_CACHE = 'polinasyon-dynamic-v6';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './ikon.png',
  './logo.png',
  './polinasyon.png',
  './polinasyon_logo.png',
  './favicon.ico'
];

// Kurulum
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Statik dosyalar önbelleğe alınıyor...');
      return cache.addAll(
        STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' }))
      );
    })
  );
  self.skipWaiting();
});

// Aktivasyon - eski cache'leri temizle
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== DYNAMIC_CACHE) {
            console.log('[SW] Eski cache siliniyor:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clientsClaim();
});

// Fetch stratejisi
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. API istekleri → Network first, offline'da cache
  if (
    url.hostname.includes('api.open-meteo.com') ||
    url.hostname.includes('rss2json') ||
    url.hostname.includes('bigdatacloud') ||
    url.hostname.includes('geocoding-api.open-meteo.com')
  ) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          const resClone = networkResponse.clone();
          caches.open(DYNAMIC_CACHE).then((cache) => {
            cache.put(event.request, resClone);
          });
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 2. Sayfa navigasyonu → Network first, offline'da index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, resClone);
          });
          return networkResponse;
        })
        .catch(() => caches.match('./index.html') || caches.match('./'))
    );
    return;
  }

  // 3. Statik dosyalar ve kütüphaneler → Cache first
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request)
        .then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200) {
            // Opaque (CORS) yanıtları da sakla (Tailwind, Lucide vb.)
            if (networkResponse && networkResponse.type === 'opaque') {
              const resClone = networkResponse.clone();
              caches.open(DYNAMIC_CACHE).then((cache) => {
                cache.put(event.request, resClone);
              });
            }
            return networkResponse;
          }

          const resClone = networkResponse.clone();
          caches.open(DYNAMIC_CACHE).then((cache) => {
            cache.put(event.request, resClone);
          });
          return networkResponse;
        })
        .catch(() => {
          // Offline ve cache'de yoksa sessizce geç
          return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        });
    })
  );
});
