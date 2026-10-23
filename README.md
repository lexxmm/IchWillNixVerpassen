# IchWillNixVerpassen

**Version 1.3.3.** Die Chrome-Erweiterung in `extension/` prüft Produkte
verschiedener Shops **ohne feste Artikelgrenze** in deiner normalen Browsersitzung und meldet erkannte
Lieferbarkeit per Telegram. Sie verwendet keinen Debugging-Anschluss und benötigt weder Cron
noch einen laufenden Node-Prozess. Das Projekt findest du auf GitHub unter
[IchWillNixVerpassen](https://github.com/lexxmm/IchWillNixVerpassen).

Pro Termin wird **genau ein Produkt** geprüft. Danach wird ein zufälliger Abstand
innerhalb der eingestellten Von-/Bis-Minuten gewählt; beim nächsten Termin folgt
das nächste Produkt. Bei drei Produkten also: **A → Pause → B → Pause → C → Pause → A**.
Die Zeitspanne gilt zwischen zwei einzelnen Produktprüfungen, nicht zwischen ganzen Runden.
Mit mehr Produkten dauert eine vollständige Runde entsprechend länger. Umfangreiche
Listen benötigen außerdem mehr Speicher und Zeit für die Darstellung im Browser.

## Installation

Benötigt wird Google Chrome ab Version 120. Die Installation erfolgt unter Windows
und Linux über dieselbe Chrome-Seite:

1. Das [Projekt auf GitHub](https://github.com/lexxmm/IchWillNixVerpassen) über
   **Code → Download ZIP** herunterladen und entpacken.
2. In Chrome `chrome://extensions` öffnen und **Entwicklermodus** einschalten.
3. **Entpackte Erweiterung laden** anklicken und den Unterordner `extension/`
   aus dem entpackten Projekt auswählen.
4. Die Einstellungsseite öffnet sich nach der Installation automatisch.

Alternativ das fertige [Erweiterungspaket](dist/ichwillnixverpassen.zip)
herunterladen, entpacken und den entpackten Ordner laden. Darin liegt die
`manifest.json` direkt im Hauptverzeichnis.

Den geladenen Ordner anschließend nicht verschieben oder löschen. Zum Aktualisieren
seine Dateien ersetzen und die Erweiterung in `chrome://extensions` über **Neu laden**
aktualisieren. Dabei dieselbe installierte Erweiterung und denselben Ordner behalten;
bisherige Produkte, Telegram-Zugangsdaten und Überwachungszustand bleiben lokal erhalten.

## Telegram einrichten

Die Einstellungen erreichst du über das Symbol „IchWillNixVerpassen“ in Chromes
Erweiterungsmenü.

1. In Telegram bei [@BotFather](https://t.me/BotFather) mit `/newbot` einen Bot
   erstellen. Dessen Token lokal in der Erweiterung eintragen und speichern.
2. Deinem neuen Bot eine Nachricht schicken. In der Erweiterung **Chat-ID ermitteln**
   anklicken, deinen Chat auswählen und die Einstellungen erneut speichern.
   Die Suche setzt einen eigenen Bot ohne aktiven Webhook voraus.
3. **Telegram testen** sendet eine Testnachricht.
4. Produkte und erforderliche Seitenfreigaben wie unten beschrieben speichern.
   **Überwachung starten** prüft sofort und plant danach jeweils den nächsten
   zufälligen Termin. **Stoppen** hält die Überwachung an.

Token und Chat-ID gehören in die lokalen Einstellungen, nicht in den Chat oder
in den Quellcode. Ein leeres Tokenfeld behält einen bereits gespeicherten Token.

## Produkte und Zeitspanne einstellen

- Über **Produkt hinzufügen** weitere verschiedene Produktseiten eintragen.
  Du kannst Produkte verschiedener Shops mischen. Jede Seite benötigt eine
  `http://`- oder `https://`-URL und einen eindeutigen Teil ihrer tatsächlichen
  Produktüberschrift. **Nach oben**, **Nach unten** und **Entfernen** ändern die Liste.
- Beim Speichern fragt Chrome bei Bedarf nach der Freigabe der eingetragenen
  Shop-Websites. Stimme zu, damit die Erweiterung diese Seiten auslesen kann.
  Bei verweigerter Freigabe kann der betroffene Shop nicht geprüft werden.
- URL-Parameter und Fragmente bleiben erhalten: etwa unterschiedliche
  `?variant=…`- oder `#…`-Varianten als getrennte Produkte speichern.
- Unter **Von (Minuten)** und **Bis (Minuten)** die zufällige Pause wählen.
  Erlaubt sind 1 bis 1440 Minuten und höchstens zwei Nachkommastellen. Gleiche Werte
  ergeben einen festen Abstand. Ohne Änderung bleiben es 15 bis 30 Minuten.
- **Einstellungen speichern** übernimmt Liste, Erkennung und Zeitspanne. Eine neue
  Zeitspanne ersetzt bei aktiver Überwachung direkt den nächsten geplanten Termin.
- Ungespeicherte Änderungen werden beim Status und im Formular angezeigt. Bis zum
  Speichern sind Start und Sofortprüfung gesperrt; **Änderungen speichern** beim
  Status übernimmt die Eingaben, ohne dass du bis zum Formularende scrollen musst.
- Wird zu einem bereits geprüften Einzelprodukt ein zweites hinzugefügt, folgt
  direkt das nächste Produkt statt einer zusätzlichen Wiederholung des ersten.
- **Nächstes Produkt jetzt prüfen** prüft ebenfalls nur das nächste Produkt und
  rückt die Reihenfolge um einen Eintrag weiter.
- Die Oberfläche zeigt das nächste Produkt und Status, Zeitpunkt und Fehler je
  Produkt. Reihenfolge und Fortschritt bleiben nach einem Browserneustart erhalten.
- Auch bei einem Lade- oder Versandfehler kommt beim nächsten Termin das folgende
  Produkt dran. Der fehlgeschlagene Eintrag wird bei seiner nächsten Runde erneut versucht.

## Erkennung anpassen

Die automatische Prüfung kombiniert Angaben zur Lieferbarkeit, die eindeutig zum
eingetragenen Produkt gehören. Die passende Produktüberschrift muss auf der Seite
erkennbar sein. Als Signale dienen:

- Ein sichtbarer, aktiver und nicht verdeckter Bestell- oder Warenkorb-Button mit
  gängiger Beschriftung, etwa **In den Warenkorb** oder **Add to cart**.
- Eindeutige Liefertexte im Produktbereich, etwa **Auf Lager**, **Sofort lieferbar** oder
  **In stock**. Ein allgemeines Werbeversprechen im Seitenkopf genügt nicht.
- Zugeordnete strukturierte Produktdaten des Shops, insbesondere die Verfügbarkeit
  eines `schema.org/Offer` in JSON-LD oder HTML-Microdata. Solche Angaben werden nur
  verwendet, wenn sie dem geprüften Produkt und seiner Variante eindeutig zugeordnet
  werden können.

Angaben wie **Ausverkauft**, **Nicht lieferbar** oder **Out of stock** werden ebenfalls
berücksichtigt. Widersprüchliche Signale, ein deaktivierter oder verdeckter
Produktbutton sowie eine unklare Variantenauswahl lösen keinen positiven Alarm aus.
Bei sichtbaren Größen- oder Farbwahlschaltern genügen allgemeine strukturierte
Lagerdaten allein nicht; dann müssen passende Angaben auf der Seite oder ein
bedienbarer Produktbutton die Lieferbarkeit bestätigen.
Hinweise wie **Artikel kann derzeit nicht gekauft werden**, **Liefertermin unbekannt**
oder **Auf Einladung erhältlich** bestätigen keine unmittelbare Bestellbarkeit und
lösen keinen Verfügbarkeitsalarm aus. Produkte, die nur auf Einladung erhältlich
sind, erscheinen ebenfalls als **Nicht kaufbar**. Empfehlungen und Angebote anderer
Varianten werden nicht als Lieferstatus des eingetragenen Artikels gewertet.

Für abweichende Shops öffnest du beim jeweiligen Produkt **Erkennung anpassen**:

- **Button-Beschriftung:** Die genaue Beschriftung des Warenkorb-Buttons eintragen, wenn
  sie von den automatisch erkannten Texten abweicht.
- **CSS-Selektor:** Bei Bedarf den Warenkorb-Button über einen eindeutigen
  CSS-Selektor im Produktbereich auswählen, zum Beispiel `button[data-action="add-to-cart"]`.
  Dieses Beispiel muss zum tatsächlichen HTML des Shops passen.

Die Felder sind optional; leer bleibt die automatische Lieferbarkeitsprüfung aktiv.
Sobald du eine eigene Beschriftung oder einen Selektor setzt, gilt diese gezielte
Button-Regel. Fehlt der gewählte Button oder ist er nicht eindeutig, wird nicht
ersatzweise aufgrund anderer Liefertexte oder strukturierter Daten alarmiert.
Verwende die Regel für den eigentlichen Produktbutton, nicht für Empfehlungen oder
das Warenkorb-Symbol in der Kopfzeile. Prüfe die Einrichtung anschließend über
**Nächstes Produkt jetzt prüfen** und den Status des betreffenden Produkts.

**Es gibt keine Garantie für alle Shops und Layouts.** Fehlt eine passende Überschrift,
ist die Zuordnung mehrdeutig oder blockiert eine Schutzseite den Zugriff, bleibt der
Status unklar. Auch ein angepasster Button-Text oder Selektor umgeht keine Zugriffssperre.

### Beispielkonfiguration

So können die Felder für einen Artikel aussehen:

- **Produktseite:** `https://shop.example/produkte/kopfhoerer`
- **Produktname:** `Kopfhörer`
- **Erkennung anpassen:** Beschriftung und CSS-Selektor leer lassen.

Die Adresse ist ein fiktives Beispiel. Für deine Einrichtung die tatsächliche
Produktadresse und einen eindeutigen Teil der echten Produktüberschrift verwenden.
Anschließend speichern, den Zugriff auf den jeweiligen Shop in Chrome bestätigen
und das Produkt prüfen lassen. Erst dabei wird der Lieferstatus der echten Seite
ermittelt.

## Verhalten und Seitenfreigaben

- Der vorhandene passende Produkttab wird bei jedem Check neu geladen. Fehlt er,
  öffnet die Erweiterung einen Hintergrundtab in derselben Chrome-Sitzung.
  Andere Tabs werden nicht geschlossen oder navigiert.
- Sie liest die Lieferangaben der Produktseite und prüft gegebenenfalls die
  Bedienbarkeit des Bestellbuttons. Es wird nichts angeklickt oder gekauft.
  Die tatsächliche serverseitige Annahme einer Bestellung oder Warenkorb-Anfrage
  wird damit nicht geprüft. Eine erforderliche Größen-, Farb- oder Variantenauswahl
  muss zur gespeicherten Produktvariante passen; aus einem allgemeinen Lagerbestand
  wird keine sichere Verfügbarkeit jeder Variante abgeleitet.
- Ladefehler, Schutzseiten und unklare Signale werden als Fehler angezeigt. Sie
  lösen keinen Verfügbarkeitsalarm aus und setzen den gespeicherten Alarmstatus
  nicht zurück. Fehlgeschlagener Telegram-Versand wird beim nächsten Check erneut
  versucht.
- Eine Meldung erfolgt für jedes Produkt getrennt bei erster bestätigter
  Verfügbarkeit und nach einem Wechsel von nicht verfügbar zu verfügbar. Ein Absturz
  genau zwischen Versand und Speicherung kann ausnahmsweise eine doppelte Meldung verursachen.
- Chrome und Rechner müssen laufen. Im Ruhezustand kann Chrome einen Termin
  verspäten; die Erweiterung weckt den Rechner nicht auf. Nach einem Browserneustart
  wird eine zuvor aktivierte Überwachung fortgesetzt.
- Die Einstellungsseite zeigt letzten Status, nächsten Termin, Fehler und die
  letzten Ereignisse. Sie muss für den Betrieb nicht geöffnet bleiben.
- Der Token wird ausschließlich im lokalen Erweiterungsspeicher gehalten und nur
  an die Telegram-API gesendet. Er wird weder an Shops noch an den Seiten-Prüfcode
  weitergegeben und nicht über Chrome Sync synchronisiert.
- Neue Shop-Domains werden optional freigegeben. Beim Speichern fordert die
  Erweiterung Zugriff für die konfigurierten Shops an; die Freigabe gilt für deren
  Website und ist nicht auf eine einzelne Produkt-URL beschränkt. Nur die
  Telegram-API ist als feste Website-Freigabe hinterlegt. Shop-Websites werden
  ausschließlich über die optionalen Freigaben der eingetragenen Domains
  angefragt. Weitere Berechtigungen dienen dem lokalen Speicher, der
  Chrome-Zeitplanung und dem Auslesen freigegebener Tabs.

Beachte die Bedingungen des jeweiligen Shops. Die Erweiterung umgeht keine Captchas
oder Zugriffssperren; ihre Veröffentlichung ist keine Zusage, dass jeder Einsatz
auf jeder Website zulässig ist.

## Entwicklung und Tests

Benötigt werden Node.js ab 22.9, npm und Python 3 für den ZIP-Build.
Nach dem Herunterladen des Projekts im Projektordner ausführen:

```bash
npm ci
npx playwright install --with-deps chromium
npm test
npm run build
```

Ist Python unter Windows nur über den Python-Launcher erreichbar, den ZIP-Build
stattdessen mit `py -3 scripts/package.py` ausführen.

Ist Google Chrome bereits installiert, können die Browser-Tests stattdessen mit
diesem Browser laufen. Unter Linux/Bash:

```bash
BROWSER_CHANNEL=chrome npm test
```

Unter Windows/PowerShell:

```powershell
$env:BROWSER_CHANNEL = "chrome"
npm test
Remove-Item Env:BROWSER_CHANNEL
```

Diese Variante verwendet eine eigene temporäre Testsitzung. Die Tests greifen
nicht auf die Einstellungen der in deinem Chrome installierten Erweiterung zu.

Die Tests liegen im Ordner `tests/`. Playwright wird ausschließlich als
Entwicklungsabhängigkeit für die Browser-Tests benötigt; die installierte
Erweiterung benötigt kein Node.js. Geprüft werden unter anderem DOM-Erkennung,
verdeckte oder fremde Buttons, Schutzseiten, Zufallsintervalle, Telegram-Fehler,
doppelte Alarme, parallele Prüfungen, Stop während laufender Arbeit und
Wiederherstellung nach Worker-Unterbrechungen. Weitere Tests prüfen Produktrotation,
getrennte Meldestatus, Migration alter Einstellungen und die Einstellungsseite.
Die Tests senden keine echten Nachrichten.

GitHub Actions führt bei Pushes und Pull Requests die Tests unter Node.js 22 und 24
aus und baut das Erweiterungspaket. `npm run build` aktualisiert
`dist/ichwillnixverpassen.zip` aus den sechs Erweiterungsdateien und dieser
Anleitung. Lokale Einstellungen, Telegram-Zugangsdaten und Browserprofile sind
nicht Bestandteil des Pakets. Nach Änderungen am Code oder der Anleitung das
Paket vor dem Commit neu bauen.

## Projektstruktur

- `extension/`: Chrome-Erweiterung; dieser Ordner wird in Chrome geladen.
- `tests/`: Tests für Erkennung, Überwachung und Einstellungsseite.
- `scripts/package.py`: Erstellt das ZIP mit festgelegter Dateiliste.
- `.github/workflows/tests.yml`: Automatische Tests und ZIP-Build auf GitHub.
- `dist/ichwillnixverpassen.zip`: Erweiterung mit Anleitung zum Weitergeben.
- `package.json` und `package-lock.json`: Entwicklungs- und Testabhängigkeiten.

## Lizenz

Für dieses Projekt wurde bislang keine Lizenz festgelegt.

Referenzen: [Erweiterung lokal laden](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked),
[optionale Seitenberechtigungen](https://developer.chrome.com/docs/extensions/reference/api/permissions),
[Chrome Alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms),
[Telegram Bot API](https://core.telegram.org/bots/api).
