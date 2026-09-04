/**
 * Kamera Yönetimi + Piksel Kontrast Kontrolü +
 * OpenCV.js tabanlı güçlendirilmiş kanat keypoint tespiti +
 * 3 Nokta Nirengi (CI / Discoidal) + Pilosity (Tüy Yoğunluğu) Tahmini
 *
 * API (mevcut metodlar DEĞİŞMEDİ, YENİ olanlar eklendi):
 *   toggle(), start(), stop(), resetPoints(),
 *   captureAndValidate(), addPoint(x,y), calculateMetrics()
 *   YENİ: capturePilosityPhoto(), estimatePilosity(x,y,halfSize),
 *         setManualPilosity(value), clearManualPilosity(),
 *         getPilosity(x,y,halfSize), resetPilosity()
 *
 * DÜZELTMELER (önceki sürüm):
 *  - ensureOpenCV(): üç ayrı yerde tekrarlanan setInterval polling,
 *    zaman aşımlı ortak bir waitFor() yardımcısına indirgendi.
 *  - _fallbackCorners(): `mask` artık gerçekten kullanılıyor.
 *  - start(): getUserMedia hatası error.name'e göre anlaşılır mesaj veriyor.
 *
 * YENİ EKLENEN (bu sürüm): PİLOSİTY DESTEĞİ
 *  - rutnerAI.js'teki puanlama algoritmasının %9'luk pilosity ağırlığı,
 *    hiçbir örnekte pilosity değeri gelmediği için pratikte her zaman
 *    "veri yok" dalına düşüyordu (sabit puan). Bu sürüm, pilosity'yi
 *    fiilen ölçüp örneğe eklemeyi mümkün kılıyor.
 *
 *  ÖNEMLİ BİLİMSEL SINIRLAMA (lütfen okuyun):
 *  Gerçek pilosity ölçümü literatürde 5. tergit üzerinde mikroskop +
 *  reticle ile tüy uzunluğunu µm cinsinden ölçmeyi gerektirir. Bu dosyadaki
 *  `estimatePilosity()` fonksiyonu, sıradan bir telefon kamerası görüntüsünde
 *  yerel doku varyansına (Laplacian) dayanan KABA bir yaklaşıklamadır —
 *  gerçek mikroskobik ölçümün yerini TUTMAZ ve saha kalibrasyonu (bilinen
 *  ırk/ekotipten referans örneklerle karşılaştırma) yapılmadan kesin kabul
 *  edilmemelidir. Bu yüzden pilosity, kanat fotoğrafından DEĞİL, ayrı bir
 *  capturePilosityPhoto() çağrısıyla alınan bağımsız bir görüntüden
 *  hesaplanır (doğru anatomik bölge kullanıcı tarafından çekilmelidir).
 *  Kullanıcının gerçek bir ölçümü varsa setManualPilosity() ile bu tahmini
 *  her zaman geçersiz kılabilir.
 */

// YENİ: window.I18N varsa (index.html tarafından yükleniyor) çeviriyi kullanır,
// yoksa (örn. bu dosya başka bir sayfada bağımsız test edilirse) orijinal
// Türkçe metne düşer.
function t(key, fallback, params) {
  return window.I18N && typeof window.I18N.t === 'function'
    ? window.I18N.t(key, params)
    : fallback;
}

function waitFor(conditionFn, { intervalMs = 50, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (conditionFn()) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      if (conditionFn()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

// Pilosity tahmini için ayarlanabilir kalibrasyon sabitleri.
// Bunlar DENEYSEL varsayımlardır; bilinen ırk/ekotipten alınmış gerçek
// tergit fotoğraflarıyla saha kalibrasyonu yapılması ÖNERİLİR.
const PILOSITY_ROI_HALF_SIZE_DEFAULT = 40; // piksel (ROI kare kenarının yarısı)
const PILOSITY_NORM_DIVISOR = 4000;        // Laplacian varyansı -> ~0-1 ölçeğine indirgeme çarpanı
const PILOSITY_MIN = 0.10;
const PILOSITY_MAX = 0.55;

export class CameraService {
  constructor(videoElement, canvasElement, placeholderElement) {
    this.video = videoElement;
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d', { willReadFrequently: true });
    this.placeholder = placeholderElement;

    this.stream = null;
    this.points = [];
    this.capturedImageData = null;

    // YENİ: pilosity için bağımsız durum (kanat noktalarından ayrı tutulur)
    this.pilosityImageData = null;
    this._manualPilosity = null;

    this.autoDetectionMode = true;
    this.cvReady = false;
    this.opencvLoading = false;

    this.ensureOpenCV();
  }

  /**
   * OpenCV.js'in yüklenip yüklenmediğini garanti eder.
   * Zaman aşımı ile döner (varsayılan 8-10 sn) — asla sonsuza kadar beklemez.
   */
  ensureOpenCV() {
    if (this.cvReady) {
      return Promise.resolve(true);
    }

    if (this.opencvLoading) {
      return waitFor(() => this.cvReady || !this.opencvLoading).then(() => this.cvReady);
    }

    this.opencvLoading = true;

    const finish = (ok) => {
      this.cvReady = ok;
      this.opencvLoading = false;
      return ok;
    };

    if (typeof cv !== 'undefined' && cv.Mat) {
      console.log('[CameraService] OpenCV.js zaten hazır');
      return Promise.resolve(finish(true));
    }

    const existingScript = document.querySelector('script[src*="opencv.js"]');
    if (existingScript) {
      return waitFor(() => typeof cv !== 'undefined' && cv.Mat, { timeoutMs: 10000 }).then((ok) => {
        if (ok) console.log('[CameraService] OpenCV.js hazır (mevcut script)');
        else console.warn('[CameraService] OpenCV.js zaman aşımına uğradı (mevcut script)');
        return finish(ok);
      });
    }

    return new Promise((resolve) => {
      const script = document.createElement('script');
      // NOT: docs.opencv.org resmi bir CDN değildir; kalıcı/çevrimdışı
      // kullanım için bu dosyanın repoya gömülüp yerelden servis edilmesi önerilir.
      script.src = './src/opencv.js';
      script.async = true;

      script.onload = () => {
        waitFor(() => typeof cv !== 'undefined' && cv.Mat, { timeoutMs: 10000 }).then((ok) => {
          if (ok) console.log('[CameraService] OpenCV.js hazır');
          else console.warn('[CameraService] OpenCV.js yüklendi ama başlatılamadı (zaman aşımı)');
          resolve(finish(ok));
        });
      };

      script.onerror = () => {
        console.warn('[CameraService] OpenCV.js yüklenemedi');
        resolve(finish(false));
      };

      document.head.appendChild(script);
    });
  }

  async toggle() {
    if (this.stream) {
      this.stop();
      return false;
    }
    return await this.start();
  }

  async start() {
    try {
      this.ensureOpenCV();

      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        console.warn('[CameraService] Güvenli olmayan bağlam (HTTP) — kamera erişimi tarayıcı tarafından engellenebilir.');
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      this.video.srcObject = this.stream;
      await this.video.play();

      this.video.style.display = 'block';
      this.placeholder.style.display = 'none';
      this.canvas.style.display = 'none';

      return true;
    } catch (error) {
      console.error('Kamera erişim hatası:', error);

      let mesaj = t('camera.cameraOpenFailed', 'Kamera açılamadı. Lütfen izinleri kontrol edin.');
      switch (error && error.name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
          mesaj = t('camera.permissionDenied', 'Kamera izni reddedildi. Tarayıcı adres çubuğundan bu site için kamera iznini açmanız gerekiyor.');
          break;
        case 'NotFoundError':
        case 'DevicesNotFoundError':
          mesaj = t('camera.notFound', 'Kamera bulunamadı. Cihazınızda kullanılabilir bir kamera olduğundan emin olun.');
          break;
        case 'NotReadableError':
        case 'TrackStartError':
          mesaj = t('camera.notReadable', 'Kameraya erişilemedi. Kamera başka bir uygulama tarafından kullanılıyor olabilir.');
          break;
        case 'OverconstrainedError':
          mesaj = t('camera.overconstrained', 'Kamera istenen çözünürlüğü desteklemiyor.');
          break;
        case 'SecurityError':
          mesaj = t('camera.securityError', 'Güvenlik kısıtlaması nedeniyle kameraya erişilemedi (HTTPS bağlantısı gerekebilir).');
          break;
      }
      alert(mesaj);
      return false;
    }
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.video.srcObject = null;
      this.video.style.display = 'none';
      this.canvas.style.display = 'none';
      this.placeholder.style.display = 'block';
    }
    this.resetPoints();
    this.resetPilosity(); // YENİ: kamera tamamen kapanınca pilosity oturumu da temizlenir
  }

  resetPoints() {
    this.points = [];
    this.capturedImageData = null;
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.canvas.style.display = 'none';
    if (this.stream) {
      this.video.style.display = 'block';
    }
  }

  /**
   * SENKRON — pedigree.js / index.html bozulmasın
   * OpenCV hazırsa otomatik A-B-C dener
   */
  captureAndValidate() {
    if (!this.stream) {
      return { valid: false, reason: t('camera.cameraOff', 'Kamera kapalı.') };
    }

    this.canvas.width = this.video.videoWidth || 640;
    this.canvas.height = this.video.videoHeight || 480;
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

    const imgData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const data = imgData.data;

    let totalVariance = 0;
    let pixelCount = 0;
    for (let i = 0; i < data.length - 16; i += 16) {
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const nextAvg = (data[i + 4] + data[i + 5] + data[i + 6]) / 3;
      totalVariance += Math.abs(avg - nextAvg);
      pixelCount++;
    }

    const contrastScore = totalVariance / (pixelCount || 1);

    if (contrastScore < 6.5) {
      return {
        valid: false,
        reason:
          t('camera.lowContrast', '⚠️ Görüntüde kanat damarı/dokusu tespit edilemedi. Lütfen net bir kanat fotoğrafı çekin.')
      };
    }

    this.capturedImageData = imgData;
    this.video.style.display = 'none';
    this.canvas.style.display = 'block';
    this.points = [];

    if (this.autoDetectionMode && this.cvReady) {
      try {
        const detected = this.detectWingKeypoints(imgData);
        if (detected && detected.length === 3) {
          this.points = detected;
          this.redrawCanvas();
          const metrics = this.calculateMetrics();
          if (metrics) {
            return { valid: true, autoDetected: true, metrics };
          }
        }
      } catch (err) {
        console.warn('Otomatik keypoint hatası:', err);
      }
    }

    return { valid: true, autoDetected: false };
  }

  /**
   * Güçlendirilmiş pipeline:
   * equalizeHist → adaptive threshold + morph → Canny birleşimi
   * → en iyi kanat konturu → sol/mid/sağ (A-B-C)
   * başarısızsa goodFeaturesToTrack fallback
   */
  detectWingKeypoints(imgData) {
    if (!this.cvReady || typeof cv === 'undefined') return null;

    let src, gray, blur, binary, morph, edges, contours, hierarchy;
    const W = imgData.width;
    const H = imgData.height;

    try {
      src = cv.matFromImageData(imgData);
      gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      blur = new cv.Mat();
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      cv.equalizeHist(blur, blur);

      binary = new cv.Mat();
      cv.adaptiveThreshold(
        blur,
        binary,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        15,
        4
      );

      const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
      morph = new cv.Mat();
      cv.morphologyEx(binary, morph, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
      cv.morphologyEx(morph, morph, cv.MORPH_OPEN, kernel, new cv.Point(-1, -1), 1);
      kernel.delete();

      edges = new cv.Mat();
      cv.Canny(blur, edges, 50, 140);
      cv.bitwise_or(morph, edges, morph);

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(morph, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);

      let bestIdx = -1;
      let bestScore = 0;

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        try {
          const area = cv.contourArea(cnt);
          if (area < W * H * 0.002 || area > W * H * 0.45) continue;

          const rect = cv.boundingRect(cnt);
          const aspect = rect.width / (rect.height || 1);
          if (aspect < 1.2) continue;

          const peri = cv.arcLength(cnt, true);
          const compactness = (peri * peri) / (area || 1);
          const score = area * Math.min(aspect, 4) / (1 + Math.abs(compactness - 25));
          if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        } finally {
          // DÜZELTİLDİ: MatVector.get() her çağrıda YENİ bir Mat wrapper
          // döndürür; silinmezse her fotoğraf denemesinde (kontur sayısı
          // kadar) OpenCV WASM heap'inde sızıntı birikir — uzun bir saha
          // oturumunda tarayıcı sekmesini çökertebilir.
          cnt.delete();
        }
      }

      if (bestIdx >= 0) {
        const cnt = contours.get(bestIdx);
        let abc = null;
        try {
          const pts = [];
          for (let j = 0; j < cnt.data32S.length; j += 2) {
            pts.push({ x: cnt.data32S[j], y: cnt.data32S[j + 1] });
          }
          abc = this._pickABCFromContour(pts, W, H);
        } finally {
          cnt.delete(); // DÜZELTİLDİ: aynı sızıntı, seçilen kontur için de
        }

        if (abc) {
          const dAB = Math.hypot(abc[1].x - abc[0].x, abc[1].y - abc[0].y);
          const dBC = Math.hypot(abc[2].x - abc[1].x, abc[2].y - abc[1].y);
          if (dBC >= 8 && dAB / dBC >= 0.8 && dAB / dBC <= 4.5) {
            return abc;
          }
        }
      }

      return this._fallbackCorners(gray, edges, W, H);
    } catch (err) {
      console.error('OpenCV keypoint hatası:', err);
      return null;
    } finally {
      try {
        if (src) src.delete();
        if (gray) gray.delete();
        if (blur) blur.delete();
        if (binary) binary.delete();
        if (morph) morph.delete();
        if (edges) edges.delete();
        if (contours) contours.delete();
        if (hierarchy) hierarchy.delete();
      } catch (_) {}
    }
  }

  _pickABCFromContour(pts, W, H) {
    if (!pts || pts.length < 30) return null;

    let left = pts[0];
    let right = pts[0];
    for (const p of pts) {
      if (p.x < left.x) left = p;
      if (p.x > right.x) right = p;
    }

    let bestMid = null;
    let maxDist = 0;
    const midY = (left.y + right.y) / 2;

    for (const p of pts) {
      if (p === left || p === right) continue;
      const d = this.pointLineDistance(p, left, right);
      const prefer = p.y < midY ? 1.25 : 0.85;
      const score = d * prefer;
      if (score > maxDist) {
        maxDist = score;
        bestMid = p;
      }
    }

    if (!bestMid || maxDist < H * 0.02) return null;

    return [
      { x: left.x, y: left.y },
      { x: bestMid.x, y: bestMid.y },
      { x: right.x, y: right.y }
    ];
  }

  /**
   * `mask` gerçekten cv.goodFeaturesToTrack()'e geçiriliyor.
   * `edges` boşsa maskesiz (yeni boş Mat) çalışır; doluysa maske olarak
   * onu kullanır. Yalnızca burada yeni oluşturulan Mat siliniyor —
   * `edges` çağırana ait olduğu için burada silinmiyor.
   */
  _fallbackCorners(gray, edges, W, H) {
    let corners = null;
    let mask = null;
    let createdMask = false;

    try {
      corners = new cv.Mat();

      if (edges && typeof edges.empty === 'function' && !edges.empty()) {
        mask = edges;
      } else {
        mask = new cv.Mat();
        createdMask = true;
      }

      cv.goodFeaturesToTrack(gray, corners, 50, 0.01, 12, mask);

      if (corners.rows < 3) {
        return null;
      }

      const candidates = [];
      for (let i = 0; i < corners.rows; i++) {
        candidates.push({
          x: corners.data32F[i * 2],
          y: corners.data32F[i * 2 + 1]
        });
      }

      return this.selectBestTriangle(candidates, W, H);
    } catch (err) {
      console.warn('Fallback corners hatası:', err);
      return null;
    } finally {
      try { if (corners) corners.delete(); } catch (_) {}
      try { if (createdMask && mask) mask.delete(); } catch (_) {}
    }
  }

  selectBestTriangle(candidates, width, height) {
    if (!candidates || candidates.length < 3) return null;

    candidates = [...candidates].sort((a, b) => a.x - b.x);

    const left = candidates[0];
    const right = candidates[candidates.length - 1];

    let bestMid = null;
    let maxDist = 0;

    for (const p of candidates) {
      if (p === left || p === right) continue;
      const dist = this.pointLineDistance(p, left, right);
      if (dist > maxDist) {
        maxDist = dist;
        bestMid = p;
      }
    }

    if (!bestMid || maxDist < height * 0.035) {
      return [
        candidates[0],
        candidates[Math.floor(candidates.length / 2)],
        candidates[candidates.length - 1]
      ];
    }

    return [left, bestMid, right];
  }

  pointLineDistance(p, a, b) {
    const A = p.x - a.x;
    const B = p.y - a.y;
    const C = b.x - a.x;
    const D = b.y - a.y;
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    const param = lenSq !== 0 ? dot / lenSq : -1;

    let xx;
    let yy;
    if (param < 0) {
      xx = a.x;
      yy = a.y;
    } else if (param > 1) {
      xx = b.x;
      yy = b.y;
    } else {
      xx = a.x + param * C;
      yy = a.y + param * D;
    }

    const dx = p.x - xx;
    const dy = p.y - yy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  addPoint(x, y) {
    if (this.points.length >= 3) {
      this.points = [];
    }

    this.points.push({ x, y });
    this.redrawCanvas();

    if (this.points.length === 3) {
      return this.calculateMetrics();
    }
    return null;
  }

  redrawCanvas() {
    if (this.capturedImageData) {
      this.ctx.putImageData(this.capturedImageData, 0, 0);
    }

    const labels = ['A', 'B', 'C'];
    const colors = ['#ef4444', '#3b82f6', '#10b981'];

    this.points.forEach((pt, index) => {
      this.ctx.beginPath();
      this.ctx.arc(pt.x, pt.y, 7, 0, 2 * Math.PI);
      this.ctx.fillStyle = colors[index];
      this.ctx.fill();
      this.ctx.lineWidth = 2;
      this.ctx.strokeStyle = '#ffffff';
      this.ctx.stroke();

      this.ctx.font = 'bold 16px sans-serif';
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillText(` ${labels[index]}`, pt.x + 10, pt.y - 10);
    });

    if (this.points.length >= 2) {
      this.drawLine(this.points[0], this.points[1], '#ef4444');
    }
    if (this.points.length === 3) {
      this.drawLine(this.points[1], this.points[2], '#3b82f6');
    }
  }

  drawLine(pt1, pt2, color) {
    this.ctx.beginPath();
    this.ctx.moveTo(pt1.x, pt1.y);
    this.ctx.lineTo(pt2.x, pt2.y);
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2.5;
    this.ctx.stroke();
  }

  calculateMetrics() {
    if (this.points.length < 3) return null;

    const [pA, pB, pC] = this.points;
    const distAB = Math.hypot(pB.x - pA.x, pB.y - pA.y);
    const distBC = Math.hypot(pC.x - pB.x, pC.y - pB.y);

    if (distBC < 1e-6) return null;

    const ci = (distAB / distBC).toFixed(2);

    // A→B→C bükülme açısı (yardımcı bilgi)
    const v1x = pA.x - pB.x;
    const v1y = pA.y - pB.y;
    const v2x = pC.x - pB.x;
    const v2y = pC.y - pB.y;
    const ang1 = Math.atan2(v1y, v1x);
    const ang2 = Math.atan2(v2y, v2x);
    let bend = ((ang2 - ang1) * 180) / Math.PI;
    while (bend > 180) bend -= 360;
    while (bend < -180) bend += 360;

    const deltaX = pC.x - pB.x;
    let rawDiscoidal = 'nötr';
    if (Math.abs(deltaX) > 10 || Math.abs(bend) > 8) {
      rawDiscoidal = deltaX > 0 ? 'pozitif' : 'negatif';
    }

    const diVal = (Math.abs(deltaX) / 10).toFixed(1);
    const di = `${rawDiscoidal.charAt(0).toUpperCase() + rawDiscoidal.slice(1)} (±${diVal})`;

    return {
      ci,
      di,
      rawDiscoidal,
      bendDeg: parseFloat(bend.toFixed(1))
    };
  }

  // ====================== YENİ: PİLOSİTY (TÜY YOĞUNLUĞU) ======================

  /**
   * Kanat fotoğrafından BAĞIMSIZ, ikinci bir kare yakalar. Kullanıcı burada
   * arının karnına/5. tergit bölgesine yakın çekim yapmalıdır — kanadın
   * tekrar çekilmesi pilosity için anlamlı bir sonuç ÜRETMEZ.
   * Basit bir kamera-açık kontrolü dışında captureAndValidate()'teki kontrast
   * eşiğini burada bilinçli olarak uygulamıyoruz; tergit dokusu kanat
   * damarlarından farklı bir kontrast profiline sahip olabilir.
   */
  async capturePilosityPhoto() {
    if (!this.stream) {
      return { valid: false, reason: t('camera.cameraOff', 'Kamera kapalı.') };
    }

    this.canvas.width = this.video.videoWidth || 640;
    this.canvas.height = this.video.videoHeight || 480;
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    this.pilosityImageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

    this.video.style.display = 'none';
    this.canvas.style.display = 'block';

    return { valid: true };
  }

  /**
   * Verilen ROI (x, y merkezli kare) içindeki yerel doku varyansını
   * (Laplacian) ölçüp 0-1 aralığında bir pilosity PROXY'si üretir.
   *
   * BİLİMSEL SINIRLAMA: Gerçek tüy uzunluğu ölçümü değildir; kalibrasyonsuz
   * mutlak doğruluk iddia edilemez (bkz. dosya başındaki not). rutnerAI.js
   * zaten bu değere sadece %9 ağırlık verir ve genel disclaimer'ı korur.
   *
   * @param {number} x - ROI merkezi (piksel, capture edilen görüntü koordinatında)
   * @param {number} y - ROI merkezi
   * @param {number} halfSize - ROI'nin yarı kenar uzunluğu (piksel)
   * @returns {number|null} 0-1 arası normalize pilosity tahmini, veya null
   */
  estimatePilosity(x, y, halfSize = PILOSITY_ROI_HALF_SIZE_DEFAULT) {
    const imgData = this.pilosityImageData || this.capturedImageData;

    if (!this.cvReady || typeof cv === 'undefined') {
      console.warn('[CameraService] OpenCV hazır değil, pilosity tahmini yapılamıyor.');
      return null;
    }
    if (!imgData) {
      console.warn('[CameraService] Pilosity için görüntü yok. Önce capturePilosityPhoto() (veya captureAndValidate()) çağrılmalı.');
      return null;
    }

    const W = imgData.width;
    const H = imgData.height;
    const x0 = Math.max(0, Math.round(x - halfSize));
    const y0 = Math.max(0, Math.round(y - halfSize));
    const w = Math.min(halfSize * 2, W - x0);
    const h = Math.min(halfSize * 2, H - y0);
    if (w <= 4 || h <= 4) return null;

    let src, gray, roi, lap, meanMat, stdMat;
    try {
      src = cv.matFromImageData(imgData);
      gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      roi = gray.roi(new cv.Rect(x0, y0, w, h));

      lap = new cv.Mat();
      cv.Laplacian(roi, lap, cv.CV_64F);

      meanMat = new cv.Mat();
      stdMat = new cv.Mat();
      cv.meanStdDev(lap, meanMat, stdMat);

      const variance = Math.pow(stdMat.data64F[0], 2);
      const normalized = Math.min(
        PILOSITY_MAX,
        Math.max(PILOSITY_MIN, variance / PILOSITY_NORM_DIVISOR)
      );

      return parseFloat(normalized.toFixed(3));
    } catch (err) {
      console.warn('[CameraService] Pilosity tahmini hatası:', err);
      return null;
    } finally {
      try { if (src) src.delete(); } catch (_) {}
      try { if (gray) gray.delete(); } catch (_) {}
      try { if (roi) roi.delete(); } catch (_) {}
      try { if (lap) lap.delete(); } catch (_) {}
      try { if (meanMat) meanMat.delete(); } catch (_) {}
      try { if (stdMat) stdMat.delete(); } catch (_) {}
    }
  }

  /**
   * Kullanıcı harici bir yöntemle (mikroskop/loop altında elle ölçüm)
   * gerçek bir pilosity değeri girmişse bunu kullan. Sağlanırsa her zaman
   * CV tahmininin önüne geçer (daha güvenilir kabul edilir).
   * @param {number} value - 0-1 arası normalize değer (referans aralık ~0.25-0.45)
   */
  setManualPilosity(value) {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0 || num > 1) {
      console.warn('[CameraService] Geçersiz pilosity değeri (0-1 arası olmalı):', value);
      return null;
    }
    this._manualPilosity = num;
    return num;
  }

  clearManualPilosity() {
    this._manualPilosity = null;
  }

  /**
   * Öncelik sırası: manuel giriş > CV tahmini > null.
   */
  getPilosity(x, y, halfSize = PILOSITY_ROI_HALF_SIZE_DEFAULT) {
    if (this._manualPilosity != null) return this._manualPilosity;
    if (x != null && y != null) return this.estimatePilosity(x, y, halfSize);
    return null;
  }

  /** Pilosity oturumunu sıfırlar (kanat noktalarından bağımsız). */
  resetPilosity() {
    this.pilosityImageData = null;
    this._manualPilosity = null;
  }
}
