const CACHE_NAME = 'polinasyon-static-v5';
const DYNAMIC_CACHE = 'polinasyon-dynamic-v5';

// Projenizde bulunan sabit dosyaları (Görseller dahil) baştan tanımlıyoruz
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './ikon.png',
  './logo.png',
  './polinasyon.png',
  './polinasyon_logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Statik dosyalar önbelleğe alınıyor...');
      // Sadece bizim sunucumuzdaki statik dosyaları indirip kilitler
      return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' })));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          // Eski versiyon önbellekleri silerek telefonu şişirmesini engelleriz
          if (key !== CACHE_NAME && key !== DYNAMIC_CACHE) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clientsClaim();
});

// Gelişmiş Çevrimdışı (Offline) Yakalama Stratejisi
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. API İstekleri (Hava durumu, RSS): Önce Ağ, Ağ Yoksa Cache
  if (url.hostname.includes('api.open-meteo.com') || url.hostname.includes('rss2json') || url.hostname.includes('bigdatacloud')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          const resClone = networkResponse.clone();
          caches.open(DYNAMIC_CACHE).then((cache) => cache.put(event.request, resClone));
          return networkResponse;
        })
        .catch(() => caches.match(event.request)) // İnternet kopuksa son API verisini döndür
    );
    return;
  }

  // 2. HTML Ana Sayfa: Yenilemelerde güncel sürümü alabilmek için Önce Ağ, Yoksa Cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          return networkResponse;
        })
        .catch(() => caches.match('./index.html')) // Dağda internet yokken sayfa yenilenirse çökmez
    );
    return;
  }

  // 3. Harici Kütüphaneler (Tailwind, Lucide) ve Statik Dosyalar: ÖNCE CACHE, Yoksa Ağ
  // RAM temizlense bile 7 dakika sonra internet aranmadan direkt cache'den okunur.
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse; // Cache'de varsa anında döndür (İnterneti bekleme)
      }
      
      // Cache'de yoksa indir ve dinamik cache'e kaydet (İlk açılış için)
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
           // Opaque (CORS dışı) yanıtları da kütüphaneler için sakla
           if(networkResponse && networkResponse.type === 'opaque') {
              const resClone = networkResponse.clone();
              caches.open(DYNAMIC_CACHE).then((cache) => cache.put(event.request, resClone));
           }
           return networkResponse;
        }
        
        const resClone = networkResponse.clone();
        caches.open(DYNAMIC_CACHE).then((cache) => {
          cache.put(event.request, resClone);
        });
        return networkResponse;
      }).catch(() => {
        // Hem cache'de yok hem internet yoksa hiçbir şey yapma
      });
    })
  );
});


