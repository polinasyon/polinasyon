/* Polinasyon Lab — Service Worker v2.14.0 (Bulletproof Offline) */
const CACHE_NAME = 'polinasyon-cache-v2.14.0';

const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './storage.js',
  './bolgeharitasi.js',
  './konum-koordinatlari.js',
  './floraveritabani.js',
  './floraveritabani-ru.js',
  './floraveritabani-eu.js',
  './nektar.js',
  './kovan.js',
  './camera.js',
  './rutnerAI.js',
  './i18n.js',
  './tr.js',
  './en.js',
  './ru.js',
  './pedigree.js',
  './ikon-192.png',
  './ikon-512.png',
  './assets/logo.svg',
  'https://cdn.tailwindcss.com'
];

// 1. KURULUM (Install) - Tüm dosyaları zorla önbelleğe al
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Promise.allSettled kullanıyoruz: Bir dosya eksik olsa bile diğerlerini yüklemeye devam eder, SW çökmez.
      return Promise.allSettled(
        STATIC_ASSETS.map((url) => {
          // Tailwind CDN gibi dış bağlantılar için CORS hatasını engellemek adına 'no-cors' modunu kullanıyoruz.
          const requestMode = url.startsWith('http') && !url.includes(self.location.hostname) ? 'no-cors' : 'cors';
          
          return fetch(new Request(url, { cache: 'reload', mode: requestMode }))
            .then((res) => {
              // CDN'den gelen opak (opaque) yanıtları veya başarılı yanıtları kaydet
              if (res.ok || res.type === 'opaque') {
                return cache.put(url, res);
              }
              throw new Error(`Yanıt alınamadı: ${url}`);
            })
            .catch(err => console.error('[SW] Önbellek hatası:', url, err));
        })
      );
    }).then(() => console.log('[SW] Kurulum Başarılı - v2.8.3'))
  );
});

// 2. AKTİVASYON (Activate) - Eski önbellekleri temizle
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// 3. İSTEK (Fetch) - Önce Önbellek, Yoksa İnternet Stratejisi
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Sadece HTTP/HTTPS protokollerini işle (chrome-extension vs atla)
  if (!url.protocol.startsWith('http')) return;

  // --- API İSTEKLERİ (Önce İnternet, Yoksa Önbellek) ---
  const apiHosts = ['api.open-meteo.com', 'archive-api.open-meteo.com', 'geocoding-api.open-meteo.com', 'api.rss2json.com', 'rss2json', 'bigdatacloud'];
  if (apiHosts.some(host => url.hostname.includes(host))) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request, { ignoreSearch: true }))
    );
    return;
  }

  // --- STATİK DOSYALAR VE DİĞERLERİ (Önce Önbellek, Yoksa İnternet) ---
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      // 1. Önbellekte varsa ANINDA onu ver (Offline modda CSS ve JS'i kurtarır)
      if (cachedResponse) {
        return cachedResponse;
      }

      // 2. Önbellekte yoksa İnternetten indirmeyi dene
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      }).catch((error) => {
        console.error('[SW] Fetch başarısız:', event.request.url, error);
        
        // KRİTİK DÜZELTME: Eğer yüklenemeyen şey bir CSS veya JS ise boş (ama geçerli) bir dosya dön!
        // Bu sayede tarayıcı Syntax Error vermez ve diğer JS kodlarının (butonların) çalışmasını durdurmaz.
        if (event.request.destination === 'style') {
           return new Response('', { status: 200, headers: {'Content-Type': 'text/css'} });
        }
        if (event.request.destination === 'script') {
           return new Response('', { status: 200, headers: {'Content-Type': 'application/javascript'} });
        }
        
        // Eğer sayfayı yeniliyorsa ve internet yoksa index.html'i ver
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html', { ignoreSearch: true });
        }
        return Response.error();
      });
    })
  );
});
