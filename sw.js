/**
 * AutoDrive Dealer Portal — Service Worker
 * Strategy:
 *   Shell assets   → Cache First (app shell never changes between deploys)
 *   API calls      → Network First with offline fallback
 *   Lead data      → Stale-While-Revalidate (show cached, update in background)
 */

const VERSION      = 'v1.0.0';                 // bump on each deploy
const SHELL_CACHE  = `autodrive-shell-${VERSION}`;
const DATA_CACHE   = `autodrive-data-${VERSION}`;
const OFFLINE_FALLBACK = '/dealer/offline.html';

// Static shell: cache on install, never hit the network for these
const SHELL_ASSETS = [
  '/dealer/',
  '/dealer/index.html',
  '/dealer/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Google Fonts subset (if self-hosted)
  // '/fonts/inter.woff2',
];

// API origins we want to cache responses from
const CACHEABLE_API_ORIGINS = [
  'https://firestore.googleapis.com',
  'https://identitytoolkit.googleapis.com',
];

// ── Install: pre-cache the shell ─────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())   // activate immediately
  );
});

// ── Activate: delete stale caches ────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== SHELL_CACHE && k !== DATA_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())  // take control of all open tabs
  );
});

// ── Fetch: route by request type ─────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Shell navigation → Cache First
  if (request.mode === 'navigate') {
    event.respondWith(cacheFirstWithOfflineFallback(request));
    return;
  }

  // 2. Static assets (same origin, not /api/) → Cache First
  if (url.origin === self.location.origin && !url.pathname.startsWith('/api/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 3. Lead / inventory API calls → Network First, cache fallback
  if (url.pathname.startsWith('/api/leads') || url.pathname.startsWith('/api/inventory')) {
    event.respondWith(networkFirstWithCache(request, DATA_CACHE));
    return;
  }

  // 4. Firestore reads → Stale-While-Revalidate
  if (CACHEABLE_API_ORIGINS.some(o => url.origin.startsWith(o.replace('https://', '')))) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  // 5. Everything else → Network only
  event.respondWith(fetch(request));
});

// ── Cache strategies ─────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function cacheFirstWithOfflineFallback(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    const offline = await caches.match(OFFLINE_FALLBACK);
    return offline || new Response('<h1>Offline</h1>', {
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

async function networkFirstWithCache(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Return empty lead list so the UI doesn't crash
    return new Response(JSON.stringify({ leads: [], fromCache: true, offline: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || fetchPromise;
}

// ── Background Sync: queue lead updates when offline ─────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-lead-updates') {
    event.waitUntil(flushOfflineLeadQueue());
  }
});

async function flushOfflineLeadQueue() {
  const db    = await openIDB();
  const queue = await getAllFromStore(db, 'offline-queue');

  for (const item of queue) {
    try {
      await fetch(item.url, {
        method:  item.method,
        headers: item.headers,
        body:    item.body,
      });
      await deleteFromStore(db, 'offline-queue', item.id);
    } catch {
      // Will retry on next sync event
      break;
    }
  }
}

// ── Push notifications for high-intent leads ─────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const { title, body, leadId, dealerId } = event.data.json();

  event.waitUntil(
    self.registration.showNotification(title || 'New High-Intent Lead', {
      body:    body || 'A buyer is ready to purchase.',
      icon:    '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      tag:     `lead-${leadId}`,          // deduplicate
      renotify: false,
      data:    { leadId, dealerId, url: `/dealer/?page=crm&lead=${leadId}` },
      actions: [
        { action: 'open',    title: 'View Lead' },
        { action: 'dismiss', title: 'Dismiss'   },
      ],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/dealer/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        const existing = clientList.find(c => c.url.includes('/dealer/'));
        if (existing) { existing.focus(); existing.postMessage({ type: 'navigate', url: targetUrl }); }
        else          { clients.openWindow(targetUrl); }
      })
  );
});

// ── Minimal IndexedDB helpers (no library) ───────────────────────────
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('autodrive-offline', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('offline-queue', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
function getAllFromStore(db, store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
function deleteFromStore(db, store, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}
