let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('playwright-core')); }
import { writeFileSync } from 'node:fs';

const BASIS = process.env.BASIS_URL || 'http://127.0.0.1:8765/';
let fehler = 0;
const pruefe = (bedingung, text) => {
  console.log(`${bedingung ? 'OK  ' : 'FEHL'} ${text}`);
  if (!bedingung) fehler++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PFAD || undefined });
const kontext = await browser.newContext({ viewport: { width: 393, height: 851 }, locale: 'de-CH' });
const seite = await kontext.newPage();

// --- A) "Letzte Einheit": Eintrag von vor 3 Tagen einspielen ---
await seite.goto(BASIS, { waitUntil: 'networkidle' });
await seite.evaluate(() => {
  const daten = JSON.parse(localStorage.getItem('gorillalog.v1'));
  const gid = daten.geraete.find((g) => g.name === 'Latzug').id;
  const vor3Tagen = Date.now() - 3 * 86400000;
  daten.log.push(
    { id: 'alt1', ts: vor3Tagen, gid, kg: 50, wdh: 12, einst: { Einstellung: '4' }, notiz: 'sauber' },
    { id: 'alt2', ts: vor3Tagen + 120000, gid, kg: 55, wdh: 10, einst: { Einstellung: '4' }, notiz: '' },
  );
  localStorage.setItem('gorillalog.v1', JSON.stringify(daten));
});
await seite.goto(BASIS, { waitUntil: 'networkidle' });
await seite.fill('.suche', 'latzug');
await seite.click('.geraet-eintrag');
await seite.waitForSelector('.geraet-kopf');
const einheitKarte = await seite.locator('.karte').first().textContent();
pruefe(einheitKarte.includes('Letzte Einheit'), 'Karte "Letzte Einheit" wird angezeigt');
pruefe(einheitKarte.includes('50 kg × 12') && einheitKarte.includes('55 kg × 10'), 'Beide Sätze der letzten Einheit sichtbar');
pruefe(einheitKarte.includes('Einstellung: 4'), 'Einstellungen der letzten Einheit sichtbar');
pruefe((await seite.locator('.steller input').nth(0).inputValue()) === '55', 'Gewicht mit letztem Satz (55) vorbelegt');
await seite.screenshot({ path: 'shot-6-letzte-einheit.png' });

// --- B) Backup-Import (ersetzt Daten nach Bestätigung) ---
const backup = {
  app: 'gorilla-log', version: 1, exportiertAm: '2026-07-01T10:00:00Z',
  daten: {
    geraete: [
      { id: 'g1', nr: '7', name: 'Test-Presse', gruppe: 'Brust', felder: ['Sitz'], archiviert: false },
    ],
    log: [
      { id: 'l1', ts: Date.now() - 86400000, gid: 'g1', kg: 30, wdh: 15, einst: { Sitz: '2' }, notiz: '' },
      { id: 'kaputt', ts: 'unsinn', gid: 'g1', kg: 30, wdh: 15, einst: {}, notiz: '' },
      { id: 'fremd', ts: Date.now(), gid: 'unbekannt', kg: 30, wdh: 15, einst: {}, notiz: '' },
    ],
  },
};
writeFileSync('backup-test.json', JSON.stringify(backup));
await seite.click('#tabs button[data-route="daten"]');
let letzterDialog = '';
seite.on('dialog', (d) => { letzterDialog = d.message(); d.accept(); });
const [dateiwahl] = await Promise.all([
  seite.waitForEvent('filechooser'),
  seite.click('button:has-text("Backup importieren")'),
]);
await dateiwahl.setFiles('backup-test.json');
await seite.waitForFunction(() => document.querySelector('.stat-tabelle') && document.body.textContent.includes('1 aktiv'));
const stat = await seite.locator('.stat-tabelle').textContent();
pruefe(stat.includes('1 aktiv'), 'Import: 1 Gerät übernommen');
pruefe(stat.includes('Gespeicherte Sätze1'), `Import: ungültige Log-Einträge verworfen, 1 gültiger übernommen`);
await seite.click('#tabs button[data-route=""]');
await seite.waitForSelector('.suche');
await seite.fill('.suche', '');
await seite.waitForSelector('.geraet-eintrag');
pruefe((await seite.locator('.geraet-eintrag').textContent()).includes('Test-Presse'), 'Importiertes Gerät in Trainingsliste');

// --- C) Defekter Speicher: wird gesichert, App startet frisch ---
await seite.evaluate(() => localStorage.setItem('gorillalog.v1', '{kaputt###'));
await seite.goto(BASIS, { waitUntil: 'networkidle' });
pruefe((await seite.locator('.geraet-eintrag').count()) === 9, 'Defekter Speicher → Neustart mit Standardkatalog');
const gerettet = await seite.evaluate(() => localStorage.getItem('gorillalog.v1.defekt'));
pruefe(gerettet === '{kaputt###', 'Defekte Daten wurden zur Rettung beiseitegelegt');

// --- D) Ungültige Eingaben werden abgelehnt ---
await seite.click('.geraet-eintrag');
await seite.waitForSelector('.geraet-kopf');
await seite.locator('.steller input').nth(2).fill('0');
await seite.click('.btn-primaer');
pruefe(letzterDialog.includes('Wiederholungen'), `Validierung: 0 Wiederholungen abgelehnt („${letzterDialog.slice(0, 40)}…“)`);
const anzahlSaetze = await seite.evaluate(() => JSON.parse(localStorage.getItem('gorillalog.v1')).log.length);
pruefe(anzahlSaetze === 0, 'Ungültiger Satz wurde nicht gespeichert');

// --- E) Mehrere Sätze auf einmal speichern ---
await seite.locator('.steller input').nth(2).fill('10');
await seite.locator('.steller input').nth(1).fill('3');
pruefe((await seite.locator('.btn-primaer').textContent()).includes('3 Sätze'), 'Knopf zeigt "3 Sätze speichern"');
await seite.click('.btn-primaer');
await seite.waitForFunction(() => document.querySelectorAll('.satz-chip').length === 3);
const logNachBlock = await seite.evaluate(() => JSON.parse(localStorage.getItem('gorillalog.v1')).log.length);
pruefe(logNachBlock === 3, 'Block-Speichern legt 3 einzelne Sätze an');

// --- F) Max-Satz (bis zur Ermüdung) ---
await seite.locator('.steller input').nth(0).fill('120');
await seite.locator('.steller input').nth(1).fill('1');
await seite.locator('.steller input').nth(2).fill('4');
await seite.check('#max-satz');
await seite.click('.btn-primaer');
await seite.waitForFunction(() => document.querySelectorAll('.satz-chip').length === 4);
const maxChip = await seite.locator('.satz-chip').last().textContent();
pruefe(maxChip.includes('120 kg × 4') && maxChip.includes('⚡'), `Max-Satz mit ⚡ markiert (${maxChip.trim()})`);
const maxFlags = await seite.evaluate(() => {
  const log = JSON.parse(localStorage.getItem('gorillalog.v1')).log;
  return log[log.length - 1].max === true && log[0].max === false;
});
pruefe(maxFlags, 'max-Flag korrekt gespeichert (Max-Satz true, normale Sätze false)');

// Vorbelegung ignoriert den Max-Satz (Arbeitsgewicht statt 120 kg)
await seite.click('#tabs button[data-route=""]');
await seite.waitForSelector('.geraet-eintrag');
await seite.click('.geraet-eintrag');
await seite.waitForSelector('.geraet-kopf');
pruefe((await seite.locator('.steller input').nth(0).inputValue()) === '20',
  'Vorbelegung nutzt letzten normalen Satz (20 kg), nicht den Max-Satz (120 kg)');

await browser.close();
console.log(fehler ? `\n${fehler} Prüfungen FEHLGESCHLAGEN` : '\nAlle Prüfungen bestanden ✓');
process.exit(fehler ? 1 : 0);
