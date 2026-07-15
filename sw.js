/* Gorilla Log – Service Worker: macht die App offline nutzbar.
 * Strategie: Cache zuerst (schnell, offline), im Hintergrund aktualisieren.
 * Es werden ausschliesslich eigene Dateien (same-origin) gecacht.
 * WICHTIG: Bei jeder Änderung an App-Dateien CACHE_NAME hochzählen –
 * das ist der einzige atomare Update-Pfad für installierte Apps. */
'use strict';

const CACHE_NAME = 'gorillalog-v1.0.1';
const DATEIEN = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (ereignis) => {
  ereignis.waitUntil(
    caches.open(CACHE_NAME)
      // 'reload' umgeht den HTTP-Cache, damit keine veralteten Dateien in die
      // neue Cache-Version übernommen werden.
      .then((cache) => cache.addAll(DATEIEN.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (ereignis) => {
  ereignis.waitUntil(
    caches.keys()
      // Nur eigene alte Caches löschen: auf GitHub Pages teilen sich alle
      // Projektseiten eines Kontos denselben Origin.
      .then((namen) => Promise.all(
        namen.filter((n) => n.startsWith('gorillalog-') && n !== CACHE_NAME).map((n) => caches.delete(n)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (ereignis) => {
  const anfrage = ereignis.request;
  if (anfrage.method !== 'GET') return;
  const url = new URL(anfrage.url);
  if (url.origin !== self.location.origin) return; // nichts Fremdes anfassen

  // Nur Navigationen zur App selbst bekommen die App-Shell. Cache-Schlüssel
  // und Netzziel sind stets identisch – so kann keine fremde Antwort den
  // Shell-Eintrag überschreiben (Cache-Poisoning).
  const istShell = anfrage.mode === 'navigate'
    && (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'));
  const ziel = istShell ? './index.html' : anfrage;

  const bearbeitung = caches.open(CACHE_NAME).then(async (cache) => {
    const imCache = await cache.match(ziel);
    const netz = fetch(ziel)
      .then((antwort) => {
        if (antwort && antwort.ok) cache.put(ziel, antwort.clone());
        return antwort;
      })
      .catch(() => null);
    const antwort = imCache || (await netz)
      || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    return { antwort, netz };
  });

  ereignis.respondWith(bearbeitung.then((b) => b.antwort));
  // Hintergrund-Update am Event-Lebenszyklus verankern, sonst darf der
  // Browser den Worker beenden, bevor cache.put durchgelaufen ist.
  ereignis.waitUntil(bearbeitung.then((b) => b.netz).then(() => undefined));
});
