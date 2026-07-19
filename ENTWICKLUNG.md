# Entwicklungs-Roadmap

Dieses Dokument ist der Arbeitsauftrag für kommende Entwicklungs-Sessions
(Mensch oder KI-Assistent). Es beschreibt die verbindlichen Arbeitsregeln,
den Ist-Zustand und die nächsten Schritte – so tief geplant, dass jeder
Schritt einzeln und ohne Rückfragen umsetzbar ist.

---

## Arbeitsregeln (bei JEDER Änderung einhalten)

1. **Anonymität:** Commits ausschliesslich mit
   `git -c user.name="cunaz" -c user.email="12928258+cunaz@users.noreply.github.com" commit …`.
   Keine Session-Links, keine privaten E-Mail-Adressen, keine Orts- oder
   Studio-Namen in Commits, Code, Kommentaren, Tests oder Screenshots.
   In Screenshots und Tests nur frei erfundene Beispielwerte – niemals
   echte Trainingsdaten des Nutzers.
2. **Null Abhängigkeiten:** Reines HTML/CSS/JS, kein Framework, kein
   Build-Schritt, keine externen Ressourcen. Die CSP in `index.html`
   (`default-src 'none'` + `'self'`) darf nicht aufgeweicht werden.
   Kein `innerHTML`, kein `eval` – DOM nur über den `el()`-Helfer.
3. **Versionierung:** Bei jeder Änderung an `index.html`, `style.css`,
   `app.js` oder `sw.js`: `CACHE_NAME` in `sw.js` **und** `APP_VERSION`
   in `app.js` hochzählen (installierte Apps aktualisieren sich nur so).
   Neue auszuliefernde Dateien zusätzlich in `DATEIEN` in `sw.js` eintragen.
4. **Kompatibilitäts-Garantie (unantastbar):** Gespeicherte Daten und alte
   Backups müssen mit jeder neuen Version funktionieren.
   - Additive, optionale Felder: kein Versions-Bump nötig; Feld in
     `normalisiereDaten` validieren und in die `unbekannteFelder`-Bekanntlisten
     aufnehmen.
   - Strukturänderungen: `DATEN_VERSION` erhöhen **und** Migrationsstufe in
     `MIGRATIONEN` ergänzen (defensiv programmieren – Eingabe ist unvalidiert).
     Migrationsstufen niemals entfernen oder ändern.
5. **Tests:** Vor jedem Push müssen beide Suiten grün sein, und jedes neue
   Feature bekommt mindestens einen E2E-Check:
   ```sh
   python3 -m http.server 8765   # im Repo-Root
   cd test && node e2e-1.mjs && node e2e-2.mjs   # ggf. CHROMIUM_PFAD setzen
   ```
6. **Sprache/Stil:** Deutsche UI in Schweizer Schreibweise (kein ß),
   Code-Bezeichner auf Deutsch wie im Bestand, bestehende Muster nutzen.
7. **Bekannte Fallstricke:**
   - `ParentNode.append()` akzeptiert keine Arrays/`null` → Spread-Muster
     `...(bedingung ? [x] : [])` verwenden (der `el()`-Helfer flacht selbst ab).
   - Inline-`style`-Attribute blockiert die CSP; `element.style.x = …`
     (CSSOM) ist erlaubt.
   - `document.createElement('svg')` erzeugt KEIN SVG – für Inline-SVG wäre
     ein `createElementNS`-Helfer nötig.
   - Modul-Zustand (`suchtext`, `bearbeiteId`, `bearbeiteSatzId`,
     `bearbeitePlanId`, `verlaufLimit`) überlebt Renderzyklen – bei
     Import/Löschen zurücksetzen.
   - Screenshots: `test/`-Screenshots sind gitignored; README-Screenshots
     liegen in `docs/` und werden mit erfundenen Seed-Daten erzeugt
     (Viewport 360×740, deviceScaleFactor 2, Seed-Zeitstempel in die
     Vergangenheit streuen, nie in die Zukunft).

## Architektur-Überblick (Stand v1.3.1)

- **`index.html`** – Shell: CSP, Manifest, vier Tabs (Training, Verlauf,
  Geräte, Daten).
- **`app.js`** – gesamte Logik, grob in Dateireihenfolge:
  Helfer (`el`, Datum, `zahlLesen`) → Standardkatalog (`standardGeraete`,
  `standardDaten`) → Datenhaltung (`DATEN_VERSION`, `MIGRATIONEN`,
  `normalisiereDaten`, `ladeDaten`, `speichere`, Rettungs-Backup
  `…defekt`) → Einstellungen (`gorillalog.einstellungen`) → Abfragen
  (`aktiverPlan`, `planSortiert`, `letzteEinheit`, `saetzeHeute`) →
  Hash-Routing (`render`) → Views (`renderTraining`, `renderGeraetAnsicht`
  inkl. Satz-Korrektur/Cardio-Modus, `renderHeuteSaetze`,
  `renderFortschritt`, `renderVerlauf`, Plan-/Geräteverwaltung,
  `renderDaten`) → Pausen-Timer → Start.
- **Datenmodell v2** (`localStorage`-Schlüssel `gorillalog.v1`):
  ```
  { version: 2,
    geraete: [{ id, nr, name, gruppe, felder[], archiviert }],
    plaene:  [{ id, name, geraete: [geraetId…] }],   // Reihenfolge = Plan
    aktiverPlanId,
    log: [{ id, ts, gid, kg, wdh, einst{}, max, notiz,
            dauerMin?, distanzKm? }] }                // ?-Felder: Cardio
  ```
  Cardio-Erkennung: `gruppe === 'Cardio'` (`istCardio()`); Cardio-Einträge
  tragen `kg:0, wdh:1` als Füllwerte.
- **`sw.js`** – Cache-first mit Hintergrund-Revalidierung; nur eigene
  Dateien, nur eigene Caches (`gorillalog-*`), Shell-Schlüssel gegen
  Cache-Poisoning fixiert.
- **Tests** – `test/e2e-1.mjs` (Kernflüsse) und `test/e2e-2.mjs`
  (Datenrobustheit, Migration, Cardio, Pläne), Playwright gegen echtes
  Chromium, ~60 Prüfungen.

## Bekannte offene Punkte (klein, kein Blocker)

- **K1 Mitternachts-Split:** Eine Einheit über Mitternacht zählt als zwei
  Trainingstage. Lösungsidee: Tagesgrenze um z. B. 03:00 verschieben
  (`tagesSchluessel` mit Offset) – als Einstellung, Default unverändert.
- **K2 Feld-Umbenennung:** Wird ein Einstellungs-Feld umbenannt, findet die
  Vorbelegung alte Werte nicht mehr (Schlüssel = Feldname). Lösungsidee:
  beim Speichern des Geräteformulars erkannte Umbenennungen (gleiche
  Position) in historischen `einst`-Schlüsseln mitziehen – optional per
  Nachfrage.
- **K3 Verlauf:** Ganze Tage lassen sich nur satzweise löschen (→ S3).
- **K4 Kappungen:** `normalisiereDaten` kappt bei 1000 Geräten / 100 000
  Sätzen, das Schreiben ist unbegrenzt. Praktisch irrelevant; sauber wäre
  eine Warnung beim Erreichen von 90 % der Grenze.
- **K5 Alt-Objekte auf GitHub:** Vor dem Public-Stellen ersetzte Commits
  können bis zur serverseitigen GC per SHA abrufbar sein (Risiko akzeptiert;
  GitHub-Support-Anfrage möglich).

## Nächste Schritte (empfohlene Reihenfolge)

Jeder Schritt ist eigenständig umsetzbar. „DoD“ = Definition of Done:
umgesetzt + E2E-Check(s) ergänzt + beide Suiten grün + Versionen gebumpt
+ README-Funktionsliste aktualisiert (falls sichtbar) + anonymer Commit.

### S1 · Update-Hinweis in der App (Aufwand: S)

**Ziel:** Nutzer sehen, dass eine neue Version geladen wurde, statt zu
raten („zweimal öffnen“).
**Umsetzung:** In `app.js` nach der SW-Registrierung auf
`navigator.serviceWorker.addEventListener('controllerchange', …)` hören
(feuert, wenn der neue Worker per `clients.claim()` übernimmt) und einen
dezenten Banner im Stil des Pausen-Banners zeigen: „Update geladen –
[Neu starten]“ (Knopf: `location.reload()`), dazu ✕ zum Ignorieren.
Guard: Banner nur zeigen, wenn vorher bereits ein Controller existierte
(sonst feuert es beim Erstbesuch). Kein Datenmodell-Change.
**Tests:** e2e: nach Erstladung `CACHE_NAME` nicht simulierbar → stattdessen
Unit-artiger Check schwierig; akzeptabel: manueller Testhinweis im PR-Text
und ein DOM-Check, dass der Banner initial versteckt ist.
**Fallstricke:** `controllerchange` feuert auch bei DevTools-„Update“;
Banner idempotent halten.

### S2 · Fortschritts-Detailansicht (Aufwand: M)

**Ziel:** Mehr als 12 Balken – echte Entwicklung über Zeit sehen.
**Umsetzung:** Neue Route `#/fortschritt/<geraetId>`; Einstieg über einen
Knopf „Mehr →“ in der bestehenden Fortschritts-Karte. Ansicht zeigt:
Zeitraum-Umschalter (12 / 26 / 52 / alle Einheiten, Chips wie beim
Plan-Umschalter), Balkenliste wie bisher (CSS-Balken wiederverwenden,
kein SVG nötig), darunter Kennzahlen pro Einheit: Top-Satz, Volumen
(Σ kg×Wdh; bei Cardio Σ Minuten und Σ km) und optional geschätztes 1RM
nach Epley (`kg × (1 + Wdh/30)`, nur für Kraft, nur Info-Zeile).
Routing: `aktuelleRoute()` liefert bereits `seite`/`arg`; in `render()`
einen Zweig `seite === 'fortschritt'` ergänzen (Tab-Markierung wie
`geraet` → Training).
**Datenmodell:** unverändert.
**Tests:** e2e-2: mit den Latzug-Seeds aus Teil A auf die Route navigieren,
Balkenanzahl und Volumen-Text prüfen.
**Fallstricke:** Zeitraum-Zustand als Modul-Variable → beim Gerätewechsel
zurücksetzen; `wert()`-Metrik strikt nach `istCardio(geraet)`.

### S3 · Verlauf: Filter + Tag löschen (Aufwand: M)

**Ziel:** Verlauf bei wachsender Historie benutzbar halten.
**Umsetzung:** Oben im Verlauf ein Suchfeld (wiederverwendbares Muster aus
`renderTraining`) + Filter-Chips für Muskelgruppen (aus vorhandenen
`gruppe`-Werten der Geräte generieren). Filter wirkt auf die Satz-Ebene
(Tage ohne Treffer ausblenden); Zähler im Tag-Kopf beziehen sich auf die
gefilterten Sätze. Zusätzlich pro Tag-Kopf ein ✕ „Tag löschen“ mit
Doppelbestätigung (Muster: Kaskaden-Löschung im Geräteformular), das alle
Sätze des Tages entfernt; Scrollposition erhalten (Muster vorhanden).
**Datenmodell:** unverändert. Filterzustand als Modul-Variable
(`verlaufFilter`), bei Import/Löschen zurücksetzen.
**Tests:** e2e: Filter nach Gerätename reduziert sichtbare Chips;
Tag-Löschung entfernt genau die Sätze des Tages (Log-Länge prüfen).

### S4 · Wochen-Statistik (Aufwand: M)

**Ziel:** Trainingslast im Blick: Einheiten/Woche und Sätze pro
Muskelgruppe/Woche (Leitlinie 10–20 Sätze pro Muskel und Woche).
**Umsetzung:** Im Daten-Tab über der Statistik-Tabelle eine Karte
„Diese Woche“: Trainingstage (distinct `tagesSchluessel` der ISO-Woche),
Sätze je Muskelgruppe (über `gid → geraet.gruppe`, Cardio separat als
Minuten), Vergleich zur Vorwoche (▲▼). ISO-Wochenschlüssel-Helfer neben
`tagesSchluessel()` implementieren (Donnerstag-Regel, lokale Zeit).
**Datenmodell:** unverändert.
**Tests:** e2e-2: Seeds über zwei Wochen einspielen, Kartentexte prüfen.
**Fallstricke:** Muskelgruppen sind Freitext – unbekannte Gruppen unter
„Sonstige“ zusammenfassen.

### S5 · Plan-Editor mit ▲▼ statt Nummern (Aufwand: S–M)

**Ziel:** Reihenfolge intuitiver ordnen.
**Umsetzung:** In `renderPlanFormular()` je Zeile zwei kleine Knöpfe ▲▼
(tauschen die Position im Arbeits-Array) plus eine Checkbox „im Plan“
statt der Nummern-Eingabe; Arbeits-Array als lokale Kopie, erst
„Speichern“ schreibt. Auf Drag & Drop bewusst verzichten (Touch-Drag ohne
Bibliothek ist fehleranfällig).
**Datenmodell:** unverändert (`plan.geraete` bleibt geordnetes Array).
**Tests:** bestehenden Plan-Test (e2e-2 Teil K) auf das neue UI umstellen.

### S6 · Gewichtsschritt pro Gerät (Aufwand: S)

**Ziel:** Maschinen mit 5-kg-Steckblöcken oder 1-kg-Scheiben korrekt
bedienen (−/+ springt heute fix 2.5 kg).
**Umsetzung:** Optionales Gerätefeld `schrittKg` (Zahl 0.25–50).
Additiv → **kein** `DATEN_VERSION`-Bump: in `normalisiereDaten` validieren
und in die Bekanntliste der Geräte aufnehmen; Eingabefeld im
Geräteformular („Gewichtsschritt (kg), leer = 2.5“); in
`renderGeraetAnsicht` `stelle(kgFeld, geraet.schrittKg || 2.5, 0, 2000)`.
**Tests:** e2e: Gerät mit `schrittKg 5` anlegen, zweimal „+“ → 30.

### S7 · CSV-Export (Aufwand: S)

**Ziel:** Auswertung in Excel/LibreOffice.
**Umsetzung:** Zweiter Export-Knopf im Daten-Tab („Export als CSV“).
Spalten: `Datum;Zeit;GeraetNr;Geraet;Muskelgruppe;kg;Wdh;Max;DauerMin;
DistanzKm;Einstellungen;Notiz`. Trennzeichen `;` (CH-Excel), Zeilenende
`\r\n`, UTF-8 **mit BOM** (`﻿`), Felder mit `"` quoten und `""`
escapen (Notizen!). Download-Mechanik vom JSON-Export übernehmen.
**Tests:** e2e: Download abfangen, Kopfzeile + eine Datenzeile prüfen.

### S8 · Optional: TWA/APK-Verpackung (Aufwand: L, extern)

Nur wenn je eine „echte“ APK gewünscht ist: PWA unverändert lassen und mit
Bubblewrap (`@bubblewrap/cli`) als Trusted Web Activity verpacken;
`assetlinks.json` unter `.well-known/` auf der Pages-Site nötig,
Signatur-Schlüssel lokal halten (NIE ins Repo). Auf GrapheneOS
funktioniert die PWA bereits gleichwertig – dieser Schritt ist Komfort,
keine Notwendigkeit. Vorerst nicht umsetzen, nur bei explizitem Wunsch.

---

## Screenshots aktualisieren (Referenz)

Playwright-Skript mit Seed-Daten (nur Fantasiewerte!) gegen den lokalen
Server laufen lassen und die drei PNGs nach `docs/` schreiben:
Startansicht, Geräteansicht (`#14` suchen), Verlauf. Zeitstempel der Seeds
immer in die Vergangenheit legen (`jetzt − n·Minuten`), sonst kippen
Einträge bei später Stunde auf „morgen“.
