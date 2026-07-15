let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('playwright-core')); }

const BASIS = process.env.BASIS_URL || 'http://127.0.0.1:8765/';
let fehler = 0;
const pruefe = (bedingung, text) => {
  console.log(`${bedingung ? 'OK  ' : 'FEHL'} ${text}`);
  if (!bedingung) fehler++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PFAD || undefined });
const kontext = await browser.newContext({
  viewport: { width: 393, height: 851 }, // Pixel-7-Format
  locale: 'de-CH',
});
const seite = await kontext.newPage();

const konsolenFehler = [];
seite.on('console', (m) => {
  if (m.type() === 'error') konsolenFehler.push(m.text());
});
seite.on('pageerror', (e) => konsolenFehler.push(String(e)));

// 1) Laden + Grundgerüst
await seite.goto(BASIS, { waitUntil: 'networkidle' });
pruefe(await seite.title() === 'Gorilla Log', 'Titel ist "Gorilla Log"');
const anzahlGeraete = await seite.locator('.geraet-eintrag').count();
pruefe(anzahlGeraete === 24, `Standardkatalog: 24 Geräte gerendert (${anzahlGeraete})`);

// 2) Suche
await seite.fill('.suche', 'bein');
const gefiltert = await seite.locator('.geraet-eintrag').count();
pruefe(gefiltert === 6, `Suche "bein" matcht Name + Muskelgruppe "Beine": 6 Treffer (${gefiltert})`);
await seite.fill('.suche', '12');
pruefe(await seite.locator('.geraet-eintrag').count() === 1, 'Suche nach Nummer "12" liefert 1 Treffer');
await seite.screenshot({ path: 'shot-1-suche.png' });

// 3) Satz erfassen an Beinpresse
await seite.click('.geraet-eintrag');
await seite.waitForSelector('.geraet-kopf');
pruefe((await seite.textContent('.geraet-kopf h2')).includes('Beinpresse'), 'Geräteansicht Beinpresse geöffnet');

// Gewicht: Standard 20 kg → 2× "+" = 25 kg
const plusKnoepfe = seite.locator('.steller button:has-text("+")');
await plusKnoepfe.nth(0).click();
await plusKnoepfe.nth(0).click();
const kgWert = await seite.locator('.steller input').nth(0).inputValue();
pruefe(kgWert === '25', `Gewichts-Steller: 20 → 25 kg (${kgWert})`);

// Einstellungs-Feld Rückenlehne ausfüllen
await seite.locator('.karte input[type="text"]').first().fill('Stufe 4');
await seite.click('.btn-primaer');
await seite.waitForSelector('.satz-chip');
const chip1 = await seite.locator('.satz-chip').first().textContent();
pruefe(chip1.includes('25 kg × 10'), `Satz gespeichert: ${chip1.trim()}`);

// zweiter Satz mit weniger Wiederholungen (Steller: 0=Gewicht, 1=Sätze, 2=Wiederholungen)
const minusKnoepfe = seite.locator('.steller button:has-text("−")');
await minusKnoepfe.nth(2).click();
await minusKnoepfe.nth(2).click();
await seite.click('.btn-primaer');
await seite.waitForFunction(() => document.querySelectorAll('.satz-chip').length >= 2);
pruefe(await seite.locator('.satz-chip').count() === 2, 'Zweiter Satz (25 kg × 8) gespeichert');
await seite.screenshot({ path: 'shot-2-geraet.png' });

// 4) Persistenz nach Neuladen
await seite.goto(BASIS, { waitUntil: 'networkidle' });
const heuteKarte = await seite.locator('.karte').first().textContent();
pruefe(heuteKarte.includes('2 Sätze an 1 Gerät'), `Heute-Zusammenfassung nach Reload: ${heuteKarte.trim().slice(0, 40)}…`);
await seite.fill('.suche', '12');
pruefe((await seite.locator('.geraet-zuletzt').first().textContent()).includes('heute'), 'Geräteliste zeigt "heute" + letzten Satz');

// 5) Vorbelegung aus letztem Satz + letzte Einstellungen
await seite.click('.geraet-eintrag');
await seite.waitForSelector('.geraet-kopf');
pruefe(await seite.locator('.steller input').nth(0).inputValue() === '25', 'Gewicht mit letztem Wert (25) vorbelegt');
pruefe(await seite.locator('.steller input').nth(2).inputValue() === '8', 'Wiederholungen mit letztem Wert (8) vorbelegt');
pruefe(await seite.locator('.karte input[type="text"]').first().inputValue() === 'Stufe 4', 'Einstellung "Rückenlehne: Stufe 4" vorbelegt');

// 6) Satz löschen
seite.once('dialog', (d) => d.accept());
await seite.locator('.satz-chip .loeschen').first().click();
await seite.waitForFunction(() => document.querySelectorAll('.satz-chip').length === 1);
pruefe(true, 'Satz löschen mit Bestätigungsdialog funktioniert');

// 7) Verlauf
await seite.click('#tabs button[data-route="verlauf"]');
await seite.waitForSelector('.tag-kopf');
const verlaufText = await seite.locator('#view').textContent();
pruefe(verlaufText.includes('Beinpresse') && verlaufText.includes('Rückenlehne: Stufe 4'),
  'Verlauf zeigt Tag, Gerät und Einstellungen');
await seite.screenshot({ path: 'shot-3-verlauf.png' });

// 8) Geräteverwaltung: neues Gerät anlegen
await seite.click('#tabs button[data-route="geraete"]');
await seite.click('.btn-primaer'); // + Neues Gerät
await seite.waitForSelector('.karte input');
const eingaben = seite.locator('.karte input');
await eingaben.nth(0).fill('42');
await eingaben.nth(1).fill('Hip Thrust Maschine');
await eingaben.nth(2).fill('Beine');
await eingaben.nth(3).fill('Rückenpolster, Fussplatte');
await seite.locator('.karte .btn-primaer').click();
await seite.waitForFunction(() => document.body.textContent.includes('Hip Thrust Maschine'));
pruefe(true, 'Neues Gerät #42 "Hip Thrust Maschine" angelegt');

// Gerät bearbeiten: Nummer ändern
await seite.locator('.geraet-eintrag', { hasText: 'Hip Thrust' }).click();
await seite.waitForSelector('.karte input');
await seite.locator('.karte input').nth(0).fill('25');
await seite.locator('.karte .btn-primaer').click();
await seite.waitForFunction(() => !document.querySelector('.karte h2'));
pruefe((await seite.locator('.geraet-eintrag', { hasText: 'Hip Thrust' }).textContent()).includes('25'),
  'Gerätenummer editierbar (42 → 25)');

// 9) Daten: Statistik + Export
await seite.click('#tabs button[data-route="daten"]');
await seite.waitForSelector('.stat-tabelle');
const statText = await seite.locator('.stat-tabelle').textContent();
pruefe(statText.includes('25 aktiv'), 'Statistik: 25 aktive Geräte');
pruefe(statText.includes('Trainingstage'), 'Statistik: Trainingstage vorhanden');
const [download] = await Promise.all([
  seite.waitForEvent('download'),
  seite.click('.btn-primaer'),
]);
const pfad = await download.path();
const { readFileSync } = await import('node:fs');
const backup = JSON.parse(readFileSync(pfad, 'utf8'));
pruefe(backup.app === 'gorilla-log' && backup.daten.log.length === 1 && backup.daten.geraete.length === 25,
  `Export: gültiges JSON-Backup (${backup.daten.geraete.length} Geräte, ${backup.daten.log.length} Satz)`);
await seite.screenshot({ path: 'shot-4-daten.png' });

// 10) Service Worker aktiv?
const swAktiv = await seite.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(reg && (reg.active || reg.installing || reg.waiting));
});
pruefe(swAktiv, 'Service Worker registriert (Offline-Modus)');

// 11) Offline-Test: Netz kappen, Startseite neu laden.
// Vorher absichtlich direkt eine Nicht-HTML-Datei ansteuern – das darf die
// gecachte App-Shell NICHT überschreiben (Regression: Cache-Poisoning im SW).
await seite.evaluate(async () => { await navigator.serviceWorker.ready; return true; });
const pngSeite = await kontext.newPage(); // eigener Tab: dessen favicon-Anfragen sind Testrauschen
await pngSeite.goto(`${BASIS}icons/icon-192.png`, { waitUntil: 'domcontentloaded' });
await pngSeite.close();
await kontext.setOffline(true);
await seite.goto(BASIS, { waitUntil: 'domcontentloaded' });
await seite.waitForSelector('.geraet-eintrag', { timeout: 5000 }).catch(() => {});
pruefe(await seite.locator('.geraet-eintrag').count() > 0, 'App lädt OFFLINE (Service-Worker-Cache)');
pruefe((await seite.locator('#view').textContent()).includes('Heute'), 'Daten offline verfügbar');
await kontext.setOffline(false);
await seite.screenshot({ path: 'shot-5-offline.png' });

// 12) Konsole sauber?
pruefe(konsolenFehler.length === 0, `Keine Konsolen-/CSP-Fehler (${konsolenFehler.length})`);
if (konsolenFehler.length) console.log(konsolenFehler.join('\n'));

await browser.close();
console.log(fehler ? `\n${fehler} Prüfungen FEHLGESCHLAGEN` : '\nAlle Prüfungen bestanden ✓');
process.exit(fehler ? 1 : 0);
