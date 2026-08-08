const CACHE_NAME = 'polinasyon-static-v7';
const DYNAMIC_CACHE = 'polinasyon-dynamic-v7';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './ikon.png',
  './logo.png',
  './polinasyon.png',
  './polinasyon_logo.png',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest'
];

// Kurulum - Varlıkları önbelleğe al
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Statik varlıklar önbelleğe alınıyor...');
      return cache.addAll(
        STATIC_ASSETS.map(url => new Request(url, { mode: 'no-cors' }))
      ).catch(err => console.log('[SW] Cache addAll uyarısı:', err));
    })
  );
  self.skipWaiting();
});

// Aktivasyon - Eski cache sürümlerini temizle
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

// Fetch İstek Stratejisi
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. API İstekleri: Önce Ağ, çevrimdışıysa son önbellekteki veriyi dön
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

  // 2. Sayfa Navigasyonu: Önce ağ, çevrimdışıysa index.html
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

  // 3. Statik Dosyalar ve Harici Kütüphaneler: Önce Önbellek (Cache-First)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request)
        .then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200) {
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
          return new Response('Çevrimdışı modda içerik yüklenemedi.', { status: 503, statusText: 'Service Unavailable' });
        });
    })
  );
});

