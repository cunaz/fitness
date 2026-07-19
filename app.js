/* Gorilla Log – Trainings-Tracker fürs Fitnessstudio.
 * Läuft vollständig lokal: keine externen Anfragen, keine Abhängigkeiten.
 * Speicher: localStorage (Export/Import als JSON-Backup).
 */
'use strict';

const APP_VERSION = '1.3.1';
const SPEICHER_SCHLUESSEL = 'gorillalog.v1';
const MUSKELGRUPPEN = ['Brust', 'Rücken', 'Schultern', 'Arme', 'Beine', 'Rumpf', 'Ganzkörper', 'Cardio'];
const RESERVIERTE_NAMEN = new Set(['__proto__', 'constructor', 'prototype']);

/* Clickjacking-Schutz: Statische Hoster wie GitHub Pages setzen keine
 * frame-ancestors-Header, darum hier die JS-Notbremse. */
if (window.top !== window.self) {
  try { window.top.location.href = window.location.href; } catch { /* fremder Frame */ }
  document.documentElement.style.display = 'none';
}

/* ============================== Hilfsfunktionen ============================== */

function neuId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/* DOM-Element bauen. Kinder werden immer als Text (textContent) eingefügt,
 * nie als HTML – Nutzereingaben können so kein Markup einschleusen. */
function el(tag, attrs, ...kinder) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
  }
  for (const kind of kinder.flat(Infinity)) {
    if (kind === null || kind === undefined || kind === false) continue;
    n.append(kind instanceof Node ? kind : document.createTextNode(String(kind)));
  }
  return n;
}

function tagesSchluessel(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function datumAnzeige(ts) {
  return new Date(ts).toLocaleDateString('de-CH', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function relativAnzeige(ts) {
  const heute = tagesSchluessel(Date.now());
  const tag = tagesSchluessel(ts);
  if (tag === heute) return 'heute';
  const diffTage = Math.round((new Date(heute) - new Date(tag)) / 86400000);
  if (diffTage <= 0) return 'heute'; // Zeitstempel minimal in der Zukunft (Uhr-Drift)
  if (diffTage === 1) return 'gestern';
  if (diffTage < 30) return `vor ${diffTage} Tg.`;
  return new Date(ts).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function kgAnzeige(kg) {
  return `${Math.round(kg * 100) / 100} kg`;
}

function zahlLesen(wert) {
  const z = parseFloat(String(wert).replace(',', '.'));
  return Number.isFinite(z) ? z : NaN;
}

/* ============================== Standard-Gerätekatalog ============================== */
/* Startkatalog nach Trainingsplan. Nummern und Namen lassen sich unter
 * „Geräte“ jederzeit anpassen; Übungen ohne Nummer stehen am Listenende. */

function standardGeraete() {
  // [Nr, Name, Muskelgruppe, Einstellungs-Felder]
  const liste = [
    ['', 'Einwärmen', 'Cardio', []],
    ['15', 'Beinpresse', 'Beine', []],
    ['14', 'Beinbeuger', 'Beine', ['Einstellung']],
    ['25', 'Latzug', 'Rücken', ['Einstellung']],
    ['24', 'Reverse Butterfly', 'Schultern', ['Einstellung']],
    ['24', 'Butterfly', 'Brust', ['Einstellung']],
    ['23', 'Brustpresse', 'Brust', ['Einstellung']],
    ['', 'Freemotion Bizepscurl', 'Arme', []],
    ['', 'Rotatoren Gummiband (rot)', 'Schultern', []],
    ['37', 'Trizepsdrücken', 'Arme', []],
    ['', 'Laufband', 'Cardio', ['Tempo', 'Steigung']],
    ['', 'Fahrrad', 'Cardio', ['Stufe']],
  ];
  return liste.map(([nr, name, gruppe, felder]) => ({
    id: neuId(), nr, name, gruppe, felder, archiviert: false,
  }));
}

/* Frischer Datenbestand: Standardkatalog plus ein Ganzkörper-Plan. */
function standardDaten() {
  const geraete = standardGeraete();
  const idVonName = new Map(geraete.map((g) => [g.name, g.id]));
  const reihenfolge = ['Einwärmen', 'Beinpresse', 'Beinbeuger', 'Latzug', 'Reverse Butterfly',
    'Butterfly', 'Brustpresse', 'Freemotion Bizepscurl', 'Rotatoren Gummiband (rot)', 'Trizepsdrücken'];
  const plan = {
    id: neuId(), name: 'Ganzkörper',
    geraete: reihenfolge.map((n) => idVonName.get(n)).filter(Boolean),
  };
  return { version: DATEN_VERSION, geraete, plaene: [plan], aktiverPlanId: plan.id, log: [] };
}

/* ============================== Datenhaltung ============================== */

/* Format-Version der gespeicherten Daten. KOMPATIBILITÄTS-GARANTIE:
 * Ändert sich das Format, wird DATEN_VERSION erhöht und in MIGRATIONEN eine
 * Stufe ergänzt, die alte Datenstände automatisch anhebt. Alte Backups und
 * localStorage-Stände bleiben so dauerhaft verwendbar – niemals eine
 * Migrationsstufe entfernen. */
const DATEN_VERSION = 2;
const MIGRATIONEN = {
  // v1 → v2: Aus den Plan-Positionen der Geräte werden benannte Trainingspläne.
  1: (d) => {
    const geraete = Array.isArray(d.geraete) ? d.geraete : [];
    const imPlan = geraete
      .filter((g) => g && typeof g === 'object' && typeof g.id === 'string'
        && g.plan !== null && g.plan !== undefined && Number.isFinite(Number(g.plan)))
      .sort((a, b) => Number(a.plan) - Number(b.plan));
    const plaene = imPlan.length
      ? [{ id: neuId(), name: 'Plan A', geraete: imPlan.map((g) => g.id) }]
      : [];
    return {
      ...d,
      version: 2,
      geraete: geraete.map((g) => {
        if (!g || typeof g !== 'object') return g;
        const { plan, ...rest } = g;
        return rest;
      }),
      plaene,
      aktiverPlanId: plaene.length ? plaene[0].id : null,
    };
  },
};

function migriereAlteVersionen(quelle) {
  let d = quelle;
  let v = Number(d.version) || 1;
  while (v < DATEN_VERSION && typeof MIGRATIONEN[v] === 'function') {
    d = MIGRATIONEN[v](d);
    const neuV = Number(d.version) || v + 1;
    if (neuV <= v) break; // Schutz vor Endlosschleife
    v = neuV;
  }
  return d;
}

/* Unbekannte (künftige) Felder eines Eintrags erhalten, statt sie zu
 * verwerfen – so überlebt ein Datenstand einer neueren App-Version den
 * Umweg über eine ältere. Begrenzung schützt vor aufgeblähten Importen. */
function unbekannteFelder(objekt, bekannt) {
  const extras = {};
  for (const [k, v] of Object.entries(objekt)) {
    if (!bekannt.includes(k) && !RESERVIERTE_NAMEN.has(k)) extras[k] = v;
  }
  try {
    if (JSON.stringify(extras).length > 4000) return {};
  } catch { return {}; }
  return extras;
}

/* Fremd-/Altdaten prüfen und in das interne Format bringen. Gibt null zurück,
 * wenn die Struktur grundsätzlich nicht passt. */
function normalisiereDaten(roh) {
  if (!roh || typeof roh !== 'object') return null;
  let quelle = roh.daten && typeof roh.daten === 'object' ? roh.daten : roh;
  quelle = migriereAlteVersionen(quelle);
  if (!quelle || !Array.isArray(quelle.geraete) || !Array.isArray(quelle.log)) return null;

  const geraete = [];
  const bekannteIds = new Set();
  for (const g of quelle.geraete.slice(0, 1000)) {
    if (!g || typeof g !== 'object') continue;
    const name = String(g.name ?? '').slice(0, 80).trim();
    if (!name) continue;
    const id = typeof g.id === 'string' && g.id.length <= 64 && !bekannteIds.has(g.id) ? g.id : neuId();
    bekannteIds.add(id);
    const felder = Array.isArray(g.felder)
      ? [...new Set(g.felder.slice(0, 10).map((f) => String(f).slice(0, 40).trim())
          .filter((f) => f && !RESERVIERTE_NAMEN.has(f)))]
      : [];
    geraete.push({
      ...unbekannteFelder(g, ['id', 'nr', 'name', 'gruppe', 'felder', 'archiviert', 'plan']),
      id,
      nr: String(g.nr ?? '').slice(0, 10).trim(),
      name,
      gruppe: String(g.gruppe ?? '').slice(0, 40).trim(),
      felder,
      archiviert: g.archiviert === true,
    });
  }

  // Trainingspläne: benannte, geordnete Geräte-Listen
  const plaene = [];
  const planIds = new Set();
  if (Array.isArray(quelle.plaene)) {
    for (const p of quelle.plaene.slice(0, 20)) {
      if (!p || typeof p !== 'object') continue;
      const planName = String(p.name ?? '').slice(0, 60).trim();
      if (!planName) continue;
      const pid = typeof p.id === 'string' && p.id.length <= 64 && !planIds.has(p.id) ? p.id : neuId();
      planIds.add(pid);
      const gids = Array.isArray(p.geraete)
        ? [...new Set(p.geraete.filter((gid) => typeof gid === 'string' && bekannteIds.has(gid)))].slice(0, 200)
        : [];
      plaene.push({
        ...unbekannteFelder(p, ['id', 'name', 'geraete']),
        id: pid, name: planName, geraete: gids,
      });
    }
  }
  const aktiverPlanId = typeof quelle.aktiverPlanId === 'string' && plaene.some((p) => p.id === quelle.aktiverPlanId)
    ? quelle.aktiverPlanId
    : (plaene.length ? plaene[0].id : null);

  const log = [];
  const logIds = new Set();
  for (const e of quelle.log.slice(0, 100000)) {
    if (!e || typeof e !== 'object') continue;
    let ts = Number(e.ts);
    const kg = Number(e.kg);
    const wdh = Number(e.wdh);
    if (!Number.isFinite(ts) || ts < 946684800000) continue;
    // Zeitstempel aus der Zukunft (falsch gestellte Uhr) behalten, aber auf jetzt begrenzen.
    if (ts > Date.now() + 86400000) ts = Date.now();
    if (!Number.isFinite(kg) || kg < 0 || kg > 2000) continue;
    if (!Number.isInteger(wdh) || wdh < 1 || wdh > 10000) continue;
    if (typeof e.gid !== 'string' || !bekannteIds.has(e.gid)) continue;
    const einst = {};
    if (e.einst && typeof e.einst === 'object') {
      for (const [k, v] of Object.entries(e.einst).slice(0, 10)) {
        const schluessel = String(k).slice(0, 40);
        const wert = String(v).slice(0, 60);
        if (schluessel && wert && !RESERVIERTE_NAMEN.has(schluessel)) einst[schluessel] = wert;
      }
    }
    const id = typeof e.id === 'string' && e.id.length <= 64 && !logIds.has(e.id) ? e.id : neuId();
    logIds.add(id);
    const eintrag = {
      ...unbekannteFelder(e, ['id', 'ts', 'gid', 'kg', 'wdh', 'einst', 'max', 'notiz', 'dauerMin', 'distanzKm']),
      id, ts, gid: e.gid, kg, wdh, einst,
      max: e.max === true, // Satz „bis zur Ermüdung“
      notiz: String(e.notiz ?? '').slice(0, 500),
    };
    const dauer = Number(e.dauerMin);
    if (Number.isFinite(dauer) && dauer > 0 && dauer <= 1440) {
      eintrag.dauerMin = Math.round(dauer * 10) / 10; // Cardio: Minuten
    }
    const distanz = Number(e.distanzKm);
    if (Number.isFinite(distanz) && distanz > 0 && distanz <= 1000) {
      eintrag.distanzKm = Math.round(distanz * 100) / 100; // Cardio: Kilometer
    }
    log.push(eintrag);
  }
  log.sort((a, b) => a.ts - b.ts);

  return {
    ...unbekannteFelder(quelle, ['version', 'geraete', 'log', 'plaene', 'aktiverPlanId']),
    version: DATEN_VERSION,
    geraete,
    plaene,
    aktiverPlanId,
    log,
  };
}

/* Originaldaten zur Rettung beiseitelegen – ein bestehendes Rettungs-Backup
 * wird dabei nie überschrieben. */
function sichereDefekt(roh) {
  try {
    if (!localStorage.getItem(`${SPEICHER_SCHLUESSEL}.defekt`)) {
      localStorage.setItem(`${SPEICHER_SCHLUESSEL}.defekt`, roh);
    }
  } catch { /* voll */ }
}

function ladeDaten() {
  let roh = null;
  try {
    roh = localStorage.getItem(SPEICHER_SCHLUESSEL);
    if (roh) {
      const geparstRoh = JSON.parse(roh);
      const geparst = normalisiereDaten(geparstRoh);
      if (geparst) {
        const quelle = geparstRoh.daten && typeof geparstRoh.daten === 'object' ? geparstRoh.daten : geparstRoh;
        // Original sichern, wenn Einträge verworfen wurden oder der Stand von
        // einer NEUEREN App-Version stammt (deren Format wir nicht voll kennen).
        const verlust = (Array.isArray(quelle.geraete) && quelle.geraete.length !== geparst.geraete.length)
          || (Array.isArray(quelle.log) && quelle.log.length !== geparst.log.length)
          || Number(quelle.version) > DATEN_VERSION;
        if (verlust) sichereDefekt(roh);
        return geparst;
      }
    }
  } catch (fehler) {
    console.error('Gespeicherte Daten unlesbar:', fehler);
  }
  if (roh) {
    sichereDefekt(roh);
    try { localStorage.removeItem(SPEICHER_SCHLUESSEL); } catch { /* nicht schreibbar */ }
  }
  return standardDaten();
}

let daten = ladeDaten();

function speichere() {
  try {
    localStorage.setItem(SPEICHER_SCHLUESSEL, JSON.stringify(daten));
    return true;
  } catch (fehler) {
    console.error(fehler);
    alert('Speichern fehlgeschlagen – der lokale Speicher ist voll oder blockiert.\n'
      + 'Bitte unter „Daten“ ein Backup exportieren.');
    return false;
  }
}

// Beim allerersten Start den Standardkatalog direkt ablegen.
try {
  if (!localStorage.getItem(SPEICHER_SCHLUESSEL)) speichere();
} catch { /* Speicher nicht verfügbar – App läuft trotzdem, nur ohne Persistenz */ }

/* ============================== App-Einstellungen ============================== */

const EINSTELLUNGEN_SCHLUESSEL = 'gorillalog.einstellungen';

function ladeEinstellungen() {
  try {
    const roh = JSON.parse(localStorage.getItem(EINSTELLUNGEN_SCHLUESSEL) || '{}');
    return { pausenTimer: roh.pausenTimer === true };
  } catch {
    return { pausenTimer: false };
  }
}

const einstellungen = ladeEinstellungen();

function speichereEinstellungen() {
  try {
    localStorage.setItem(EINSTELLUNGEN_SCHLUESSEL, JSON.stringify(einstellungen));
  } catch { /* nicht kritisch */ }
}

/* Beim ersten Start dauerhaften Speicher anfragen (verringert das Risiko,
 * dass der Browser die Daten bei Platzmangel löscht). */
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

/* ============================== Abfragen ============================== */

function geraetVonId(id) {
  return daten.geraete.find((g) => g.id === id) || null;
}

function vergleicheNr(a, b) {
  const na = parseFloat(a.nr);
  const nb = parseFloat(b.nr);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  if (Number.isFinite(na) && !Number.isFinite(nb)) return -1;
  if (!Number.isFinite(na) && Number.isFinite(nb)) return 1;
  return a.name.localeCompare(b.name, 'de');
}

function geraeteSortiert() {
  return [...daten.geraete].sort(vergleicheNr);
}

function aktiverPlan() {
  return daten.plaene.find((p) => p.id === daten.aktiverPlanId) || null;
}

/* Für den Training-Tab: Geräte des aktiven Plans zuerst (in Plan-Reihenfolge),
 * der Rest nach Nummer. */
function planSortiert() {
  const plan = aktiverPlan();
  const position = new Map(plan ? plan.geraete.map((gid, i) => [gid, i]) : []);
  return [...daten.geraete].sort((a, b) => {
    const pa = position.has(a.id) ? position.get(a.id) : Infinity;
    const pb = position.has(b.id) ? position.get(b.id) : Infinity;
    if (pa !== pb) return pa - pb;
    return vergleicheNr(a, b);
  });
}

function logVonGeraet(gid) {
  return daten.log.filter((e) => e.gid === gid);
}

function letzterEintrag(gid) {
  const eintraege = logVonGeraet(gid);
  return eintraege.length ? eintraege[eintraege.length - 1] : null;
}

/* Sätze der letzten abgeschlossenen Einheit (letzter Trainingstag vor heute). */
function letzteEinheit(gid) {
  const heute = tagesSchluessel(Date.now());
  const eintraege = logVonGeraet(gid).filter((e) => tagesSchluessel(e.ts) !== heute);
  if (!eintraege.length) return null;
  const letzterTag = tagesSchluessel(eintraege[eintraege.length - 1].ts);
  return eintraege.filter((e) => tagesSchluessel(e.ts) === letzterTag);
}

function saetzeHeute(gid) {
  const heute = tagesSchluessel(Date.now());
  return logVonGeraet(gid).filter((e) => tagesSchluessel(e.ts) === heute);
}

/* ============================== Navigation ============================== */

const ansicht = document.getElementById('view');
let suchtext = '';

function navigiere(route) {
  if (location.hash === `#/${route}`) render();
  else location.hash = `#/${route}`;
}

for (const knopf of document.querySelectorAll('#tabs button')) {
  knopf.addEventListener('click', () => navigiere(knopf.dataset.route));
}

window.addEventListener('hashchange', render);

function aktuelleRoute() {
  const teile = location.hash.replace(/^#\/?/, '').split('/');
  let arg = '';
  if (teile[1]) {
    try { arg = decodeURIComponent(teile[1]); } catch { /* verstümmelter Link */ }
  }
  return { seite: teile[0] || '', arg };
}

function render() {
  const { seite, arg } = aktuelleRoute();
  const tab = seite === 'geraet' ? '' : seite;
  for (const knopf of document.querySelectorAll('#tabs button')) {
    knopf.classList.toggle('aktiv', knopf.dataset.route === tab);
  }
  ansicht.replaceChildren();
  window.scrollTo(0, 0);
  if (seite === 'geraet') {
    const geraet = geraetVonId(arg);
    if (geraet) renderGeraetAnsicht(geraet);
    // replace statt push: sonst führt die Zurück-Taste immer wieder auf die
    // ungültige Geräte-Route und der Nutzer kommt nie aus der Schleife.
    else location.replace('#/');
  } else if (seite === 'verlauf') renderVerlauf();
  else if (seite === 'geraete') renderGeraeteVerwaltung();
  else if (seite === 'daten') renderDaten();
  else renderTraining();
}

/* ============================== Ansicht: Training ============================== */

function renderTraining() {
  const heute = tagesSchluessel(Date.now());
  const saetzeDesTages = daten.log.filter((e) => tagesSchluessel(e.ts) === heute);
  const plan = aktiverPlan();
  const planGeraete = plan
    ? plan.geraete.map(geraetVonId).filter((g) => g && !g.archiviert)
    : [];

  const kopfKarte = el('div', { class: 'karte' });

  // Plan-Umschalter, sobald es mehrere Pläne gibt
  if (daten.plaene.length > 1) {
    kopfKarte.append(el('div', { class: 'satz-chips' },
      daten.plaene.map((p) => el('button', {
        type: 'button',
        class: `satz-chip tippbar plan-chip${p.id === daten.aktiverPlanId ? ' aktiv' : ''}`,
        onclick: () => {
          daten.aktiverPlanId = p.id;
          speichere();
          render();
        },
      }, p.name))));
  }

  if (plan && planGeraete.length) {
    const offen = planGeraete.filter((g) => !saetzeHeute(g.id).length);
    kopfKarte.append(el('div', { class: daten.plaene.length > 1 ? 'heute-zeile' : undefined },
      `${plan.name} heute: ${planGeraete.length - offen.length} von ${planGeraete.length} erledigt`));
    if (offen.length) {
      const naechstes = offen[0];
      kopfKarte.append(el('button', {
        type: 'button', class: 'btn btn-klein plan-naechstes',
        onclick: () => navigiere(`geraet/${encodeURIComponent(naechstes.id)}`),
      }, `Als Nächstes: ${naechstes.nr ? `#${naechstes.nr} ` : ''}${naechstes.name} ›`));
    } else {
      kopfKarte.append(el('div', { class: 'plan-fertig' }, 'Plan komplett ✓ 💪'));
    }
  }

  if (saetzeDesTages.length) {
    const proGeraet = new Map();
    for (const e of saetzeDesTages) {
      proGeraet.set(e.gid, (proGeraet.get(e.gid) || 0) + 1);
    }
    kopfKarte.append(
      el('div', { class: planGeraete.length ? 'heute-zeile' : undefined }, `Heute: ${saetzeDesTages.length} ${saetzeDesTages.length === 1 ? 'Satz' : 'Sätze'} an ${proGeraet.size} ${proGeraet.size === 1 ? 'Gerät' : 'Geräten'}`),
      el('div', { class: 'satz-chips' },
        [...proGeraet.entries()].map(([gid, anzahl]) => {
          const g = geraetVonId(gid);
          return el('span', { class: 'satz-chip' }, `${g ? g.name : '?'} · ${anzahl}×`);
        })),
    );
  }

  if (kopfKarte.childNodes.length) ansicht.append(kopfKarte);

  const suche = el('input', {
    class: 'suche', type: 'text', placeholder: 'Gerät suchen (Nummer oder Name) …',
    autocomplete: 'off', value: suchtext,
    oninput: (ev) => { suchtext = ev.target.value; renderGeraetListe(liste); },
  });
  ansicht.append(suche);

  const liste = el('div', { class: 'geraet-liste' });
  ansicht.append(liste);
  renderGeraetListe(liste);
}

function renderGeraetListe(container) {
  const filter = suchtext.trim().toLowerCase();
  const geraete = planSortiert().filter((g) => !g.archiviert).filter((g) => {
    if (!filter) return true;
    return g.nr.toLowerCase().startsWith(filter)
      || g.name.toLowerCase().includes(filter)
      || g.gruppe.toLowerCase().includes(filter);
  });

  container.replaceChildren();
  if (!geraete.length) {
    container.append(el('p', { class: 'leer' },
      filter ? 'Kein Gerät gefunden.' : 'Noch keine Geräte – unter „Geräte“ anlegen.'));
    return;
  }
  for (const g of geraete) {
    const letzter = letzterEintrag(g.id);
    const heuteErledigt = saetzeHeute(g.id).length > 0;
    container.append(
      el('button', {
        type: 'button', class: 'geraet-eintrag',
        onclick: () => navigiere(`geraet/${encodeURIComponent(g.id)}`),
      },
      el('span', { class: `nr-badge${heuteErledigt ? ' erledigt' : ''}` }, heuteErledigt ? '✓' : (g.nr || '–')),
      el('span', { class: 'geraet-info' },
        el('div', { class: 'geraet-name' }, g.name),
        el('div', { class: 'geraet-meta' }, g.gruppe || '')),
      el('span', { class: 'geraet-zuletzt' },
        letzter ? [relativAnzeige(letzter.ts), el('br'), satzText(letzter)] : '')),
    );
  }
}

/* ============================== Ansicht: Gerät / Satz erfassen ============================== */

function einstAnzeige(einst) {
  return Object.entries(einst).map(([k, v]) => `${k}: ${v}`).join(' · ');
}

/* Geräte der Muskelgruppe „Cardio“ erfassen Dauer statt Gewicht × Wiederholungen. */
function istCardio(geraet) {
  return geraet.gruppe.trim().toLowerCase() === 'cardio';
}

function satzText(e) {
  if (e.dauerMin || e.distanzKm) {
    const teile = [];
    if (e.dauerMin) teile.push(`${e.dauerMin} min`);
    if (e.distanzKm) teile.push(`${e.distanzKm} km`);
    return teile.join(' · ') + (e.max ? ' ⚡' : '');
  }
  return `${kgAnzeige(e.kg)} × ${e.wdh}${e.max ? ' ⚡' : ''}`;
}

function satzChip(e, praefix = '', beimTippen = null) {
  return el('span', {
    class: `satz-chip${e.max ? ' max' : ''}${beimTippen ? ' tippbar' : ''}`,
    onclick: beimTippen || undefined,
  }, `${praefix}${satzText(e)}`);
}

let bearbeiteSatzId = null; // ID des Satzes, der gerade korrigiert wird

function renderGeraetAnsicht(geraet) {
  const satzInBearbeitung = bearbeiteSatzId
    ? daten.log.find((e) => e.id === bearbeiteSatzId && e.gid === geraet.id) || null
    : null;
  if (!satzInBearbeitung) bearbeiteSatzId = null;

  ansicht.append(
    el('button', { type: 'button', class: 'zurueck', onclick: () => history.back() }, '‹ Zurück'),
    el('div', { class: 'geraet-kopf' },
      el('span', { class: 'nr-badge' }, geraet.nr || '–'),
      el('div', null,
        el('h2', null, geraet.name),
        el('div', { class: 'geraet-meta' }, geraet.gruppe || ''))),
  );

  // Letzte Einheit als Referenz („was habe ich letztes Mal gemacht?“)
  const einheit = letzteEinheit(geraet.id);
  if (einheit) {
    const letzte = einheit[einheit.length - 1];
    ansicht.append(
      el('div', { class: 'karte' },
        el('div', { class: 'geraet-meta' }, `Letzte Einheit · ${datumAnzeige(letzte.ts)}`),
        el('div', { class: 'satz-chips' },
          einheit.map((e) => satzChip(e, '', () => { bearbeiteSatzId = e.id; render(); }))),
        Object.keys(letzte.einst).length
          ? el('div', { class: 'einst-zeile' }, einstAnzeige(letzte.einst)) : null,
        letzte.notiz ? el('div', { class: 'notiz-zeile' }, letzte.notiz) : null),
    );
  }

  // Formular: beim Korrigieren mit dem angetippten Satz vorbelegt, sonst mit
  // dem jüngsten normalen Satz (Arbeitsgewicht) – ein Max-Satz soll nicht das
  // nächste Training vorbelegen.
  const vorlage = satzInBearbeitung
    || [...logVonGeraet(geraet.id)].reverse().find((e) => !e.max)
    || letzterEintrag(geraet.id);
  const cardio = istCardio(geraet);
  const form = el('div', { class: 'karte' });

  const dauerFeld = el('input', {
    type: 'number', inputmode: 'decimal', step: '1', min: '1', max: '1440',
    value: vorlage && vorlage.dauerMin ? String(vorlage.dauerMin) : '10',
    'aria-label': 'Dauer in Minuten',
  });
  const distanzFeld = el('input', {
    type: 'number', inputmode: 'decimal', step: '0.1', min: '0', max: '1000',
    value: vorlage && vorlage.distanzKm ? String(vorlage.distanzKm) : '',
    placeholder: 'optional', 'aria-label': 'Distanz in Kilometern',
  });

  const kgFeld = el('input', {
    type: 'number', inputmode: 'decimal', step: '0.5', min: '0', max: '2000',
    value: vorlage ? String(vorlage.kg) : '20', 'aria-label': 'Gewicht in kg',
  });
  const saetzeFeld = el('input', {
    type: 'number', inputmode: 'numeric', step: '1', min: '1', max: '20',
    value: '1', 'aria-label': 'Anzahl Sätze',
  });
  const wdhFeld = el('input', {
    type: 'number', inputmode: 'numeric', step: '1', min: '1', max: '10000',
    value: vorlage ? String(vorlage.wdh) : '10', 'aria-label': 'Wiederholungen',
  });

  const stelle = (feld, schritt, min, max) => (richtung) => {
    const wert = zahlLesen(feld.value);
    const neu = Math.min(max, Math.max(min, (Number.isFinite(wert) ? wert : min) + richtung * schritt));
    feld.value = String(Math.round(neu * 100) / 100);
    feld.dispatchEvent(new Event('input'));
  };
  const kgStellen = stelle(kgFeld, 2.5, 0, 2000);
  const saetzeStellen = stelle(saetzeFeld, 1, 1, 20);
  const wdhStellen = stelle(wdhFeld, 1, 1, 10000);
  const dauerStellen = stelle(dauerFeld, 5, 1, 1440);

  const einstFelder = new Map();
  const einstEingaben = geraet.felder.map((feldName) => {
    const eingabe = el('input', {
      type: 'text', autocomplete: 'off', maxlength: '60',
      value: vorlage && Object.prototype.hasOwnProperty.call(vorlage.einst, feldName)
        ? vorlage.einst[feldName] : '',
    });
    einstFelder.set(feldName, eingabe);
    return [el('label', null, feldName), eingabe];
  });

  const maxFeld = el('input', { type: 'checkbox', id: 'max-satz' });
  maxFeld.checked = !!(satzInBearbeitung && satzInBearbeitung.max);
  const notizFeld = el('input', { type: 'text', autocomplete: 'off', maxlength: '500', placeholder: 'optional' });
  if (satzInBearbeitung) notizFeld.value = satzInBearbeitung.notiz;
  const speichernKnopf = el('button', { type: 'button', class: 'btn btn-primaer' });
  const heuteBereich = el('div');

  const knopfText = () => {
    if (satzInBearbeitung) return 'Änderungen speichern';
    if (cardio) return 'Eintrag speichern';
    const n = zahlLesen(saetzeFeld.value);
    return Number.isInteger(n) && n > 1 ? `${n} Sätze speichern` : 'Satz speichern';
  };
  speichernKnopf.textContent = knopfText();
  saetzeFeld.addEventListener('input', () => { speichernKnopf.textContent = knopfText(); });

  const zeigeErfolg = (text) => {
    if (speichere()) {
      if (navigator.vibrate) navigator.vibrate(40);
      speichernKnopf.replaceChildren(el('span', { class: 'ok-blitz' }, text));
      if (einstellungen.pausenTimer) startePause(90);
    } else {
      // Einträge bleiben im Arbeitsspeicher (Export weiterhin möglich), aber
      // kein falsches Erfolgssignal zeigen.
      speichernKnopf.replaceChildren('⚠ nicht gespeichert');
    }
    setTimeout(() => speichernKnopf.replaceChildren(knopfText()), 1400);
    renderHeuteSaetze(heuteBereich, geraet);
  };

  speichernKnopf.addEventListener('click', () => {
    const einst = {};
    for (const [feldName, eingabe] of einstFelder) {
      const wert = eingabe.value.trim().slice(0, 60);
      if (wert) einst[feldName] = wert;
    }
    const notiz = notizFeld.value.trim().slice(0, 500);

    if (cardio) {
      const dauer = zahlLesen(dauerFeld.value);
      if (!Number.isFinite(dauer) || dauer <= 0 || dauer > 1440) { alert('Bitte eine gültige Dauer (1–1440 Minuten) eingeben.'); return; }
      const dauerMin = Math.round(dauer * 10) / 10;
      let distanzKm;
      if (distanzFeld.value.trim() !== '') {
        const distanz = zahlLesen(distanzFeld.value);
        if (!Number.isFinite(distanz) || distanz <= 0 || distanz > 1000) { alert('Bitte eine gültige Distanz (0–1000 km) eingeben oder das Feld leer lassen.'); return; }
        distanzKm = Math.round(distanz * 100) / 100;
      }
      if (satzInBearbeitung) {
        // max: false – bei Cardio gibt es keinen Max-Satz; ein ehemaliger
        // Kraft-Eintrag verliert das Flag beim Umtragen.
        Object.assign(satzInBearbeitung, { dauerMin, distanzKm, einst: { ...einst }, max: false, notiz });
        if (!distanzKm) delete satzInBearbeitung.distanzKm;
        speichere();
        bearbeiteSatzId = null;
        render();
        return;
      }
      const eintrag = {
        id: neuId(), ts: Date.now(), gid: geraet.id,
        kg: 0, wdh: 1, dauerMin, einst: { ...einst }, max: false, notiz,
      };
      if (distanzKm) eintrag.distanzKm = distanzKm;
      daten.log.push(eintrag);
      zeigeErfolg('✓ gespeichert');
      return;
    }

    const kg = zahlLesen(kgFeld.value);
    const saetze = satzInBearbeitung ? 1 : zahlLesen(saetzeFeld.value);
    const wdh = zahlLesen(wdhFeld.value);
    if (!Number.isFinite(kg) || kg < 0 || kg > 2000) { alert('Bitte ein gültiges Gewicht (0–2000 kg) eingeben.'); return; }
    if (!Number.isInteger(saetze) || saetze < 1 || saetze > 20) { alert('Bitte eine gültige Satz-Anzahl (1–20) eingeben.'); return; }
    if (!Number.isInteger(wdh) || wdh < 1 || wdh > 10000) { alert('Bitte gültige Wiederholungen (ganze Zahl ab 1) eingeben.'); return; }

    if (satzInBearbeitung) {
      // Korrektur: bestehenden Satz aktualisieren, Zeitstempel bleibt
      Object.assign(satzInBearbeitung, {
        kg: Math.round(kg * 100) / 100, wdh, einst: { ...einst },
        max: maxFeld.checked, notiz,
      });
      speichere();
      bearbeiteSatzId = null;
      render();
      return;
    }

    const basisTs = Date.now();
    for (let i = 0; i < saetze; i++) {
      daten.log.push({
        id: neuId(), ts: basisTs + i, gid: geraet.id,
        kg: Math.round(kg * 100) / 100, wdh, einst: { ...einst },
        max: maxFeld.checked, notiz,
      });
    }
    zeigeErfolg(saetze > 1 ? `✓ ${saetze} Sätze gespeichert` : '✓ gespeichert');
  });

  form.append(
    ...(satzInBearbeitung ? [el('div', { class: 'geraet-meta' },
      `Korrigieren: Satz vom ${datumAnzeige(satzInBearbeitung.ts)} (${satzText(satzInBearbeitung)})`)] : []),
    ...(cardio ? [
      el('label', null, 'Dauer (Minuten)'),
      el('div', { class: 'steller' },
        el('button', { type: 'button', 'aria-label': 'Dauer verringern', onclick: () => dauerStellen(-1) }, '−'),
        dauerFeld,
        el('button', { type: 'button', 'aria-label': 'Dauer erhöhen', onclick: () => dauerStellen(1) }, '+')),
      el('label', null, 'Distanz (km)'),
      distanzFeld,
    ] : [
      el('label', null, 'Gewicht (kg)'),
      el('div', { class: 'steller' },
        el('button', { type: 'button', 'aria-label': 'Gewicht verringern', onclick: () => kgStellen(-1) }, '−'),
        kgFeld,
        el('button', { type: 'button', 'aria-label': 'Gewicht erhöhen', onclick: () => kgStellen(1) }, '+')),
      ...(satzInBearbeitung ? [] : [
        el('label', null, 'Sätze'),
        el('div', { class: 'steller' },
          el('button', { type: 'button', 'aria-label': 'Sätze verringern', onclick: () => saetzeStellen(-1) }, '−'),
          saetzeFeld,
          el('button', { type: 'button', 'aria-label': 'Sätze erhöhen', onclick: () => saetzeStellen(1) }, '+')),
      ]),
      el('label', null, satzInBearbeitung ? 'Wiederholungen' : 'Wiederholungen (pro Satz)'),
      el('div', { class: 'steller' },
        el('button', { type: 'button', 'aria-label': 'Wiederholungen verringern', onclick: () => wdhStellen(-1) }, '−'),
        wdhFeld,
        el('button', { type: 'button', 'aria-label': 'Wiederholungen erhöhen', onclick: () => wdhStellen(1) }, '+')),
      el('label', { class: 'kontrollzeile', for: 'max-satz' },
        maxFeld, 'Bis zur Ermüdung (Max-Satz) ⚡'),
    ]),
    ...einstEingaben.flat(),
    el('label', null, 'Notiz'),
    notizFeld,
    speichernKnopf,
    ...(satzInBearbeitung ? [el('button', {
      type: 'button', class: 'btn',
      onclick: () => { bearbeiteSatzId = null; render(); },
    }, 'Abbrechen')] : []),
  );

  ansicht.append(form, heuteBereich);
  renderHeuteSaetze(heuteBereich, geraet);
  const fortschritt = renderFortschritt(geraet);
  if (fortschritt) ansicht.append(fortschritt);
}

function renderHeuteSaetze(container, geraet) {
  container.replaceChildren();
  const saetze = saetzeHeute(geraet.id);
  if (!saetze.length) return;
  container.append(
    el('div', { class: 'karte' },
      el('div', { class: 'geraet-meta' }, `Heute · ${saetze.length} ${saetze.length === 1 ? 'Satz' : 'Sätze'} · zum Korrigieren antippen`),
      el('div', { class: 'satz-chips' },
        saetze.map((e, i) => el('span', {
          class: `satz-chip tippbar${e.max ? ' max' : ''}`,
          onclick: () => { bearbeiteSatzId = e.id; render(); },
        },
        `${i + 1}. ${satzText(e)}`,
        el('button', {
          type: 'button', class: 'loeschen', 'aria-label': 'Satz löschen',
          onclick: (ev) => {
            ev.stopPropagation();
            if (!confirm(`Satz ${i + 1} (${satzText(e)}) löschen?`)) return;
            daten.log = daten.log.filter((x) => x.id !== e.id);
            if (bearbeiteSatzId === e.id) bearbeiteSatzId = null;
            speichere();
            render();
          },
        }, '✕'))))),
  );
}

/* Entwicklung des Top-Satzes pro Trainingstag (Kraft: höchstes Gewicht,
 * Cardio: längste Dauer) */
function renderFortschritt(geraet) {
  // Metrik nach Gerätetyp, damit nie Kilogramm mit Minuten verglichen werden.
  const cardio = istCardio(geraet);
  const wert = (e) => (cardio ? (e.dauerMin || 0) : e.kg);
  const proTag = new Map();
  for (const e of logVonGeraet(geraet.id)) {
    const tag = tagesSchluessel(e.ts);
    const bisher = proTag.get(tag);
    if (!bisher || wert(e) > wert(bisher)) proTag.set(tag, e);
  }
  const tage = [...proTag.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-12);
  if (tage.length < 2) return null;
  const maxWert = Math.max(1, ...tage.map(([, e]) => wert(e)));
  const karte = el('div', { class: 'karte' },
    el('div', { class: 'geraet-meta' }, `Fortschritt · Top-Satz der letzten ${tage.length} Einheiten`));
  for (const [, e] of tage) {
    const balken = el('span', { class: `fortschritt-balken${e.max ? ' max' : ''}` });
    balken.style.width = `${Math.max(4, Math.round((wert(e) / maxWert) * 100))}%`;
    karte.append(el('div', { class: 'fortschritt-zeile' },
      el('span', { class: 'fortschritt-datum' },
        new Date(e.ts).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })),
      el('span', { class: 'fortschritt-spur' }, balken),
      el('span', { class: 'fortschritt-wert' }, satzText(e))));
  }
  return karte;
}

/* ============================== Ansicht: Verlauf ============================== */

let verlaufLimit = 30;

function renderVerlauf() {
  if (!daten.log.length) {
    ansicht.append(el('p', { class: 'leer' }, 'Noch keine Einträge. Leg los! 🏋️'));
    return;
  }

  // Nach Tag gruppieren (neueste zuerst)
  const tage = new Map();
  for (const e of daten.log) {
    const schluessel = tagesSchluessel(e.ts);
    if (!tage.has(schluessel)) tage.set(schluessel, []);
    tage.get(schluessel).push(e);
  }
  const tagesListe = [...tage.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));

  for (const [, eintraege] of tagesListe.slice(0, verlaufLimit)) {
    const proGeraet = new Map();
    for (const e of eintraege) {
      if (!proGeraet.has(e.gid)) proGeraet.set(e.gid, []);
      proGeraet.get(e.gid).push(e);
    }

    ansicht.append(
      el('div', { class: 'tag-kopf' },
        el('span', { class: 'datum' }, datumAnzeige(eintraege[0].ts)),
        el('span', { class: 'zusammenfassung' },
          `${eintraege.length} ${eintraege.length === 1 ? 'Satz' : 'Sätze'} · ${proGeraet.size} ${proGeraet.size === 1 ? 'Gerät' : 'Geräte'}`)),
    );

    const karte = el('div', { class: 'karte' });
    for (const [gid, saetze] of proGeraet) {
      const g = geraetVonId(gid);
      const letzterSatz = saetze[saetze.length - 1];
      karte.append(
        el('div', { class: 'verlauf-geraet' },
          el('button', {
            type: 'button', class: 'name-zeile',
            onclick: () => { if (g) navigiere(`geraet/${encodeURIComponent(g.id)}`); },
          },
          el('span', { class: 'nr' }, g && g.nr ? `#${g.nr} ` : ''),
          g ? g.name : 'Gelöschtes Gerät'),
          el('div', { class: 'satz-chips' },
            saetze.map((e) => el('span', {
              class: `satz-chip tippbar${e.max ? ' max' : ''}`,
              onclick: () => {
                if (!g) return;
                bearbeiteSatzId = e.id;
                navigiere(`geraet/${encodeURIComponent(g.id)}`);
              },
            },
            satzText(e),
            el('button', {
              type: 'button', class: 'loeschen', 'aria-label': 'Satz löschen',
              onclick: (ev) => {
                ev.stopPropagation();
                if (!confirm(`Satz (${satzText(e)}) vom ${datumAnzeige(e.ts)} löschen?`)) return;
                daten.log = daten.log.filter((x) => x.id !== e.id);
                if (bearbeiteSatzId === e.id) bearbeiteSatzId = null;
                speichere();
                const y = window.scrollY;
                render();
                window.scrollTo(0, y);
              },
            }, '✕')))),
          Object.keys(letzterSatz.einst).length
            ? el('div', { class: 'einst-zeile' }, einstAnzeige(letzterSatz.einst)) : null,
          saetze.filter((e) => e.notiz).map((e) => el('div', { class: 'notiz-zeile' }, e.notiz))),
      );
    }
    ansicht.append(karte);
  }

  if (tagesListe.length > verlaufLimit) {
    ansicht.append(el('button', {
      type: 'button', class: 'btn',
      onclick: () => {
        verlaufLimit += 30;
        const y = window.scrollY;
        render();
        window.scrollTo(0, y);
      },
    }, `Ältere Tage anzeigen (${tagesListe.length - verlaufLimit} weitere)`));
  }
}

/* ============================== Ansicht: Geräteverwaltung ============================== */

let bearbeiteId = null; // null = kein Formular, '' = neues Gerät, sonst Geräte-ID

/* Fügt Standard-Geräte hinzu, die (nach Name) noch fehlen – bestehende
 * Geräte und der Trainingsverlauf bleiben unangetastet. So kommen neue
 * Katalog-Geräte auch in einen bestehenden Datenbestand. */
function ergaenzeStandardGeraete() {
  const vorhandene = new Set(daten.geraete.map((g) => g.name.trim().toLowerCase()));
  const neue = standardGeraete().filter((g) => !vorhandene.has(g.name.trim().toLowerCase()));
  if (!neue.length) {
    alert('Alle Standard-Geräte sind bereits vorhanden.');
    return;
  }
  daten.geraete.push(...neue);
  speichere();
  render();
  alert(`${neue.length} ${neue.length === 1 ? 'Gerät' : 'Geräte'} ergänzt: ${neue.map((g) => g.name).join(', ')}`);
}

let bearbeitePlanId = null; // null = kein Plan-Formular, '' = neuer Plan, sonst Plan-ID

function renderPlanVerwaltung() {
  const bereich = el('div', null, el('h2', null, 'Trainingspläne'));
  if (daten.plaene.length) {
    bereich.append(el('div', { class: 'geraet-liste' },
      daten.plaene.map((p) => el('button', {
        type: 'button', class: 'geraet-eintrag',
        onclick: () => { bearbeitePlanId = p.id; render(); },
      },
      el('span', { class: `nr-badge${p.id === daten.aktiverPlanId ? '' : ' inaktiv'}` },
        p.id === daten.aktiverPlanId ? '★' : '☆'),
      el('span', { class: 'geraet-info' },
        el('div', { class: 'geraet-name' }, p.name),
        el('div', { class: 'geraet-meta' },
          `${p.geraete.length} Geräte${p.id === daten.aktiverPlanId ? ' · aktiv' : ''}`)),
      el('span', { class: 'geraet-zuletzt' }, '✎')))));
  }
  bereich.append(el('button', {
    type: 'button', class: 'btn',
    onclick: () => { bearbeitePlanId = ''; render(); },
  }, '+ Neuer Plan'));
  if (bearbeitePlanId !== null) bereich.append(renderPlanFormular());
  return bereich;
}

function renderPlanFormular() {
  const plan = bearbeitePlanId ? daten.plaene.find((p) => p.id === bearbeitePlanId) : null;
  const positionVon = new Map(plan ? plan.geraete.map((gid, i) => [gid, i + 1]) : []);
  const nameFeld = el('input', { type: 'text', maxlength: '60', value: plan ? plan.name : '' });
  const posFelder = new Map();
  const zeilen = geraeteSortiert().filter((g) => !g.archiviert).map((g) => {
    const feld = el('input', {
      type: 'number', inputmode: 'numeric', min: '1', max: '999', placeholder: '–',
      value: positionVon.has(g.id) ? String(positionVon.get(g.id)) : '',
      'aria-label': `Position von ${g.name}`,
    });
    posFelder.set(g.id, feld);
    return el('div', { class: 'plan-zeile' },
      el('span', { class: 'plan-zeile-name' }, `${g.nr ? `#${g.nr} ` : ''}${g.name}`),
      feld);
  });

  const form = el('div', { class: 'karte' },
    el('h2', null, plan ? `Plan bearbeiten: ${plan.name}` : 'Neuer Plan'),
    el('label', null, 'Name'), nameFeld,
    el('p', { class: 'hinweis' }, 'Reihenfolge-Nummer eintragen; leer = Gerät gehört nicht zu diesem Plan.'),
    zeilen,
    el('div', { class: 'btn-reihe' },
      el('button', {
        type: 'button', class: 'btn btn-primaer',
        onclick: () => {
          const name = nameFeld.value.trim().slice(0, 60);
          if (!name) { alert('Bitte einen Namen eingeben.'); return; }
          const eintraege = [];
          for (const [gid, feld] of posFelder) {
            const wert = Math.round(zahlLesen(feld.value));
            if (Number.isFinite(wert) && wert >= 1) eintraege.push([wert, gid]);
          }
          eintraege.sort((a, b) => a[0] - b[0]);
          const gids = eintraege.map(([, gid]) => gid);
          if (plan) {
            plan.name = name;
            plan.geraete = gids;
          } else {
            const neu = { id: neuId(), name, geraete: gids };
            daten.plaene.push(neu);
            if (!daten.aktiverPlanId) daten.aktiverPlanId = neu.id;
          }
          speichere();
          bearbeitePlanId = null;
          render();
        },
      }, 'Speichern'),
      el('button', {
        type: 'button', class: 'btn',
        onclick: () => { bearbeitePlanId = null; render(); },
      }, 'Abbrechen')),
  );

  if (plan) {
    form.append(el('div', { class: 'btn-reihe' },
      el('button', {
        type: 'button', class: 'btn',
        onclick: () => {
          daten.aktiverPlanId = plan.id;
          speichere();
          render();
        },
      }, plan.id === daten.aktiverPlanId ? '★ Aktiver Plan' : 'Als aktiv setzen'),
      el('button', {
        type: 'button', class: 'btn btn-gefahr',
        onclick: () => {
          if (!confirm(`Plan „${plan.name}“ löschen? Geräte und Trainingsverlauf bleiben erhalten.`)) return;
          daten.plaene = daten.plaene.filter((p) => p.id !== plan.id);
          if (daten.aktiverPlanId === plan.id) {
            daten.aktiverPlanId = daten.plaene.length ? daten.plaene[0].id : null;
          }
          speichere();
          bearbeitePlanId = null;
          render();
        },
      }, 'Löschen')));
  }

  return form;
}

function renderGeraeteVerwaltung() {
  ansicht.append(renderPlanVerwaltung(), el('h2', null, 'Geräte'));
  ansicht.append(
    el('button', {
      type: 'button', class: 'btn btn-primaer',
      onclick: () => { bearbeiteId = ''; render(); },
    }, '+ Neues Gerät'),
    el('button', {
      type: 'button', class: 'btn',
      onclick: ergaenzeStandardGeraete,
    }, 'Fehlende Standard-Geräte ergänzen'),
    el('p', { class: 'hinweis' },
      'Nummern und Namen an dein Studio anpassen. „Einstellungs-Felder“ sind die Regler, '
      + 'die du dir merken willst (z. B. Sitzhöhe) – kommagetrennt.'),
  );

  if (bearbeiteId !== null) renderGeraetFormular();

  const aktive = geraeteSortiert().filter((g) => !g.archiviert);
  const archivierte = geraeteSortiert().filter((g) => g.archiviert);

  const zeile = (g) => el('button', {
    type: 'button', class: `geraet-eintrag${g.archiviert ? ' archiviert' : ''}`,
    onclick: () => { bearbeiteId = g.id; render(); },
  },
  el('span', { class: 'nr-badge' }, g.nr || '–'),
  el('span', { class: 'geraet-info' },
    el('div', { class: 'geraet-name' }, g.name),
    el('div', { class: 'geraet-meta' },
      [g.gruppe, g.felder.join(', ')].filter(Boolean).join(' · '))),
  el('span', { class: 'geraet-zuletzt' }, g.archiviert ? 'archiviert' : '✎'));

  ansicht.append(el('div', { class: 'geraet-liste' }, aktive.map(zeile)));
  if (archivierte.length) {
    ansicht.append(
      el('h2', null, 'Archiviert'),
      el('div', { class: 'geraet-liste' }, archivierte.map(zeile)),
    );
  }
}

function renderGeraetFormular() {
  const geraet = bearbeiteId ? geraetVonId(bearbeiteId) : null;

  const nrFeld = el('input', { type: 'text', inputmode: 'numeric', maxlength: '10', value: geraet ? geraet.nr : '' });
  const nameFeld = el('input', { type: 'text', maxlength: '80', value: geraet ? geraet.name : '' });
  const gruppeFeld = el('input', { type: 'text', maxlength: '40', list: 'gruppen-liste', value: geraet ? geraet.gruppe : '' });
  const felderFeld = el('input', {
    type: 'text', maxlength: '400', placeholder: 'z. B. Sitzhöhe, Rückenlehne',
    value: geraet ? geraet.felder.join(', ') : '',
  });

  const form = el('div', { class: 'karte' },
    el('h2', null, geraet ? `Gerät bearbeiten: ${geraet.name}` : 'Neues Gerät'),
    el('label', null, 'Nummer im Studio'), nrFeld,
    el('label', null, 'Name'), nameFeld,
    el('label', null, 'Muskelgruppe'), gruppeFeld,
    el('datalist', { id: 'gruppen-liste' }, MUSKELGRUPPEN.map((g) => el('option', { value: g }))),
    el('label', null, 'Einstellungs-Felder (kommagetrennt)'), felderFeld,
    el('div', { class: 'btn-reihe' },
      el('button', {
        type: 'button', class: 'btn btn-primaer',
        onclick: () => {
          const name = nameFeld.value.trim().slice(0, 80);
          if (!name) { alert('Bitte einen Namen eingeben.'); return; }
          const felder = [...new Set(felderFeld.value.split(',')
            .map((f) => f.trim().slice(0, 40))
            .filter((f) => f && !RESERVIERTE_NAMEN.has(f)))].slice(0, 10);
          const werte = {
            nr: nrFeld.value.trim().slice(0, 10),
            name,
            gruppe: gruppeFeld.value.trim().slice(0, 40),
            felder,
          };
          if (geraet) Object.assign(geraet, werte);
          else daten.geraete.push({ id: neuId(), archiviert: false, ...werte });
          speichere();
          bearbeiteId = null;
          render();
        },
      }, 'Speichern'),
      el('button', {
        type: 'button', class: 'btn',
        onclick: () => { bearbeiteId = null; render(); },
      }, 'Abbrechen')),
  );

  if (geraet) {
    form.append(el('div', { class: 'btn-reihe' },
      el('button', {
        type: 'button', class: 'btn',
        onclick: () => {
          geraet.archiviert = !geraet.archiviert;
          speichere();
          bearbeiteId = null;
          render();
        },
      }, geraet.archiviert ? 'Reaktivieren' : 'Archivieren'),
      el('button', {
        type: 'button', class: 'btn btn-gefahr',
        onclick: () => {
          const anzahl = logVonGeraet(geraet.id).length;
          const frage = anzahl
            ? `„${geraet.name}“ hat ${anzahl} gespeicherte Sätze. Gerät UND alle Sätze endgültig löschen?`
            : `„${geraet.name}“ löschen?`;
          if (!confirm(frage)) return;
          if (anzahl && !confirm(`Sicher? ${anzahl} Sätze Trainingsverlauf gehen unwiederbringlich verloren. `
            + 'Tipp: Archivieren behält den Verlauf.')) return;
          daten.geraete = daten.geraete.filter((g) => g.id !== geraet.id);
          daten.log = daten.log.filter((e) => e.gid !== geraet.id);
          for (const p of daten.plaene) {
            p.geraete = p.geraete.filter((gid) => gid !== geraet.id);
          }
          speichere();
          bearbeiteId = null;
          render();
        },
      }, 'Löschen')));
    ansicht.append(el('p', { class: 'hinweis' },
      'Tipp: Archivieren statt löschen behält den Trainingsverlauf.'));
  }

  ansicht.append(form);
}

/* ============================== Ansicht: Daten ============================== */

function renderDaten() {
  const trainingsTage = new Set(daten.log.map((e) => tagesSchluessel(e.ts))).size;
  const erster = daten.log.length ? datumAnzeige(daten.log[0].ts) : '–';
  let belegung = '–';
  try {
    const roh = localStorage.getItem(SPEICHER_SCHLUESSEL) || '';
    belegung = `${Math.max(1, Math.round(roh.length / 1024))} KB`;
  } catch { /* Speicher nicht lesbar */ }

  const persistZelle = el('td', null, 'unbekannt');
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted()
      .then((ja) => { persistZelle.textContent = ja ? 'ja' : 'nein (Backups machen!)'; })
      .catch(() => {});
  }

  const statKarte = el('div', { class: 'karte' },
    el('table', { class: 'stat-tabelle' },
      el('tr', null, el('td', null, 'Geräte'), el('td', null,
        `${daten.geraete.filter((g) => !g.archiviert).length} aktiv, ${daten.geraete.filter((g) => g.archiviert).length} archiviert`)),
      el('tr', null, el('td', null, 'Gespeicherte Sätze'), el('td', null, String(daten.log.length))),
      el('tr', null, el('td', null, 'Trainingstage'), el('td', null, String(trainingsTage))),
      el('tr', null, el('td', null, 'Erster Eintrag'), el('td', null, erster)),
      el('tr', null, el('td', null, 'Speicherbelegung'), el('td', null, belegung)),
      el('tr', null, el('td', null, 'Dauerhafter Speicher'), persistZelle),
      el('tr', null, el('td', null, 'Version'), el('td', null, APP_VERSION))));

  // Export: JSON-Datei erzeugen und herunterladen
  const exportKnopf = el('button', {
    type: 'button', class: 'btn btn-primaer',
    onclick: () => {
      const inhalt = JSON.stringify({
        app: 'gorilla-log', version: DATEN_VERSION,
        exportiertAm: new Date().toISOString(),
        daten: { ...daten, version: DATEN_VERSION },
      }, null, 1);
      const blob = new Blob([inhalt], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `gorilla-log-backup-${tagesSchluessel(Date.now())}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
  }, 'Backup exportieren (JSON)');

  // Import: JSON-Datei einlesen, prüfen, ersetzen
  const importEingabe = el('input', { type: 'file', accept: 'application/json,.json', class: 'versteckt' });
  importEingabe.addEventListener('change', () => {
    const datei = importEingabe.files && importEingabe.files[0];
    importEingabe.value = '';
    if (!datei) return;
    if (datei.size > 50 * 1024 * 1024) { alert('Datei ist zu gross (max. 50 MB).'); return; }
    const leser = new FileReader();
    leser.onload = () => {
      let neu = null;
      try { neu = normalisiereDaten(JSON.parse(String(leser.result))); } catch { /* unlesbar */ }
      if (!neu) { alert('Diese Datei ist kein gültiges Gorilla-Log-Backup.'); return; }
      const ok = confirm(`Backup gefunden: ${neu.geraete.length} Geräte, ${neu.log.length} Sätze.\n`
        + 'Die aktuellen Daten werden vollständig ersetzt. Fortfahren?');
      if (!ok) return;
      daten = neu;
      bearbeiteId = null;
      bearbeiteSatzId = null;
      bearbeitePlanId = null;
      suchtext = '';
      speichere();
      alert('Backup erfolgreich importiert.');
      render();
    };
    leser.onerror = () => alert('Datei konnte nicht gelesen werden.');
    leser.readAsText(datei);
  });
  const importKnopf = el('button', {
    type: 'button', class: 'btn', onclick: () => importEingabe.click(),
  }, 'Backup importieren');

  const loeschKnopf = el('button', {
    type: 'button', class: 'btn btn-gefahr',
    onclick: () => {
      if (!confirm('Wirklich ALLE Daten löschen (Geräte und kompletter Verlauf)?')) return;
      if (!confirm('Letzte Warnung: Ohne Backup sind die Daten unwiederbringlich weg. Trotzdem löschen?')) return;
      try {
        localStorage.removeItem(SPEICHER_SCHLUESSEL);
        localStorage.removeItem(`${SPEICHER_SCHLUESSEL}.defekt`);
      } catch { /* Speicher nicht schreibbar */ }
      daten = standardDaten();
      bearbeiteId = null;
      bearbeiteSatzId = null;
      bearbeitePlanId = null;
      suchtext = '';
      speichere();
      render();
    },
  }, 'Alle Daten löschen');

  const timerFeld = el('input', { type: 'checkbox', id: 'einstellung-pause' });
  timerFeld.checked = einstellungen.pausenTimer;
  timerFeld.addEventListener('change', () => {
    einstellungen.pausenTimer = timerFeld.checked;
    speichereEinstellungen();
  });

  ansicht.append(
    el('h2', null, 'Statistik'),
    statKarte,
    el('h2', null, 'Einstellungen'),
    el('div', { class: 'karte' },
      el('label', { class: 'kontrollzeile', for: 'einstellung-pause' },
        timerFeld, 'Pausen-Timer: nach jedem gespeicherten Satz 90-Sekunden-Countdown anzeigen')),
    el('h2', null, 'Backup'),
    el('div', { class: 'karte' },
      el('p', { class: 'hinweis' },
        'Alle Daten liegen ausschliesslich lokal auf diesem Gerät. '
        + 'Exportiere regelmässig ein Backup, z. B. vor einem Browser- oder Gerätewechsel.'),
      exportKnopf, importKnopf, importEingabe),
    el('h2', null, 'Gefahrenzone'),
    el('div', { class: 'karte' }, loeschKnopf),
    el('p', { class: 'hinweis' },
      'Gorilla Log sendet nichts ins Internet: keine Konten, kein Tracking, keine externen Dienste.'),
  );
}

/* ============================== Pausen-Timer (optional) ============================== */

let pauseEnde = 0;
let pauseTicker = null;
let pauseAusblendung = null;
const pauseText = el('span', { class: 'pause-text' });
const pausePlus = el('button', {
  type: 'button',
  onclick: () => { if (pauseEnde) { pauseEnde += 30000; aktualisierePause(); } },
}, '+30 s');
const pauseBanner = el('div', { class: 'pause-banner versteckt' },
  pauseText, pausePlus,
  el('button', { type: 'button', 'aria-label': 'Pause ausblenden', onclick: () => beendePause(true) }, '✕'));
document.body.append(pauseBanner);

function startePause(sekunden) {
  // Eine noch ausstehende Ausblendung vom letzten Countdown darf den
  // neuen nicht mitten im Lauf verstecken.
  clearTimeout(pauseAusblendung);
  pauseAusblendung = null;
  pauseEnde = Date.now() + sekunden * 1000;
  pauseBanner.classList.remove('versteckt');
  pausePlus.classList.remove('versteckt');
  if (!pauseTicker) pauseTicker = setInterval(aktualisierePause, 250);
  aktualisierePause();
}

function beendePause(ausblenden) {
  clearInterval(pauseTicker);
  pauseTicker = null;
  pauseEnde = 0;
  if (ausblenden) {
    clearTimeout(pauseAusblendung);
    pauseAusblendung = null;
    pauseBanner.classList.add('versteckt');
  }
}

function aktualisierePause() {
  const rest = pauseEnde - Date.now();
  if (rest <= 0) {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    pauseText.textContent = 'Pause vorbei 💪';
    pausePlus.classList.add('versteckt');
    beendePause(false);
    pauseAusblendung = setTimeout(() => pauseBanner.classList.add('versteckt'), 4000);
    return;
  }
  const s = Math.ceil(rest / 1000);
  pauseText.textContent = `⏱ Pause ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ============================== Start ============================== */

render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((fehler) => {
    // Ohne HTTPS (oder localhost) gibt es keinen Offline-Modus – die App läuft trotzdem.
    console.warn('Service-Worker nicht registriert:', fehler);
  });
}
