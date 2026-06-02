/**
 * Al-Fajar Hadir — Service Worker
 * Strategi per-resource:
 *  - App shell (HTML)          → Cache-First, fallback ke offline page
 *  - CDN JS/CSS (versioned)    → Cache-First (stale OK, versi jarang berubah)
 *  - Google Fonts              → Cache-First, stale-while-revalidate
 *  - face-api models (binary)  → Cache-First, long-lived (file besar, jarang update)
 *  - Firebase RTDB / API       → Network-First, fallback ke response 503 agar
 *                                 app-level code tetap bisa handle offline
 */

const SW_VERSION   = 'v1';
const CACHE_SHELL  = `alfajar-shell-${SW_VERSION}`;
const CACHE_CDN    = `alfajar-cdn-${SW_VERSION}`;
const CACHE_FONTS  = `alfajar-fonts-${SW_VERSION}`;
const CACHE_MODELS = `alfajar-models-${SW_VERSION}`;

// ── Resource yang di-pre-cache saat install ──────────────────────────────────
const SHELL_ASSETS = [
  './',          // index.html
  './sw.js',
];

const CDN_PRECACHE = [
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js',
  // Tabler icons — besar tapi statis; cache agar offline tetap ada ikon
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css',
];

// face-api model files — pre-cache agar face recognition jalan offline
const MODEL_BASE = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
const MODEL_FILES = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model-shard1',
  'ssd_mobilenetv1_model-shard2',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2',
];

// ── Install: pre-cache shell & CDN ───────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_SHELL).then(c =>
        c.addAll(SHELL_ASSETS).catch(e => console.warn('[SW] Shell cache partial:', e))
      ),
      caches.open(CACHE_CDN).then(c =>
        // Pakai individual add agar satu CDN gagal tidak batalkan semua
        Promise.allSettled(CDN_PRECACHE.map(url =>
          c.add(new Request(url, { mode: 'cors', credentials: 'omit' }))
            .catch(e => console.warn('[SW] CDN skip:', url, e.message))
        ))
      ),
      // Model face-api: cache tanpa blocking install (bisa besar > 10 MB)
      caches.open(CACHE_MODELS).then(c =>
        Promise.allSettled(MODEL_FILES.map(f =>
          c.add(new Request(`${MODEL_BASE}/${f}`, { mode: 'cors', credentials: 'omit' }))
            .catch(e => console.warn('[SW] Model skip:', f, e.message))
        ))
      ),
    ]).then(() => self.skipWaiting())
  );
});

// ── Activate: bersihkan cache lama ───────────────────────────────────────────
self.addEventListener('activate', event => {
  const KEEP = [CACHE_SHELL, CACHE_CDN, CACHE_FONTS, CACHE_MODELS];
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('alfajar-') && !KEEP.includes(k))
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: routing per URL pattern ───────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Abaikan: chrome-extension, non-GET, POST Firebase
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // ── Firebase RTDB & API → Network-First ──────────────────────────────────
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebaseapp.com') ||
    url.hostname.includes('firebase.com') ||
    url.hostname.includes('gstatic.com')
  ) {
    event.respondWith(networkFirst(request, null));
    return;
  }

  // ── face-api model files → Cache-First (long-lived) ──────────────────────
  if (url.href.includes('vladmandic/face-api/model')) {
    event.respondWith(cacheFirst(request, CACHE_MODELS));
    return;
  }

  // ── Google Fonts → Stale-While-Revalidate ────────────────────────────────
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(staleWhileRevalidate(request, CACHE_FONTS));
    return;
  }

  // ── CDN JS/CSS (versioned, tidak pernah berubah) → Cache-First ───────────
  if (
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname.includes('jsdelivr')
  ) {
    event.respondWith(cacheFirst(request, CACHE_CDN));
    return;
  }

  // ── App Shell (HTML & aset lokal) → Cache-First with network fallback ─────
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, CACHE_SHELL));
    return;
  }

  // ── Default: network only ─────────────────────────────────────────────────
  event.respondWith(fetch(request).catch(() => offlineResponse(request)));
});

// ── Strategi Cache ────────────────────────────────────────────────────────────

/**
 * Cache-First: cek cache dulu, network sebagai fallback & update cache.
 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineResponse(request);
  }
}

/**
 * Network-First: coba network, kalau gagal (offline) return cache atau 503.
 */
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (cacheName && response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (cacheName) {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(request);
      if (cached) return cached;
    }
    // Return 503 agar app-level catch() tahu jaringan tidak ada
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Stale-While-Revalidate: return cache segera, update di background.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || await networkFetch || offlineResponse(request);
}

/**
 * Fallback response saat benar-benar offline dan tidak ada cache.
 */
function offlineResponse(request) {
  const accept = request.headers.get('Accept') || '';
  if (accept.includes('text/html')) {
    return new Response(
      `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Al-Fajar — Offline</title>
      <style>
        body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
          min-height:100vh;margin:0;background:#0F1610;color:#E8F5EB;flex-direction:column;gap:12px;text-align:center;padding:20px}
        h2{font-size:20px;margin:0}p{color:#7AAB82;font-size:14px;margin:0}
        .icon{font-size:48px;margin-bottom:8px}
        button{margin-top:16px;padding:12px 28px;border-radius:10px;border:none;
          background:#166534;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
      </style></head>
      <body>
        <div class="icon">🕌</div>
        <h2>Al-Fajar Hadir</h2>
        <p>Tidak ada koneksi internet.<br>Data absensi tetap tersimpan lokal.</p>
        <button onclick="location.reload()">Coba Lagi</button>
      </body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
  return new Response('offline', { status: 503 });
}

// ── Background Sync: flush antrian absensi offline ────────────────────────────
// Dipanggil dari app via postMessage saat online kembali.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'SYNC_CHECK') {
    // Kirim balik ke app agar tahu SW aktif
    event.source.postMessage({ type: 'SW_READY', version: SW_VERSION });
  }
});
