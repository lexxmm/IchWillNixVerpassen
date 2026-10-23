# Pokémon Center Check

Die Chrome-Erweiterung in `extension/` prüft bis zu **zehn verschiedene Produkte** in deiner normalen
Browsersitzung und meldet Verfügbarkeit per Telegram. Sie verwendet keinen
Debugging-Anschluss und benötigt weder Cron noch einen laufenden Node-Prozess.

Pro Termin wird **genau ein Produkt** geprüft. Danach wird ein zufälliger Abstand
innerhalb der eingestellten Von-/Bis-Minuten gewählt; beim nächsten Termin folgt
das nächste Produkt. Bei drei Produkten also: **A → Pause → B → Pause → C → Pause → A**.
Die Zeitspanne gilt zwischen zwei einzelnen Produktprüfungen, nicht zwischen ganzen Runden.

## Installation

Benötigt wird Google Chrome ab Version 120.

1. Das [Projekt auf GitHub](https://github.com/lexxmm/PokemonCenterCheck) über
   **Code → Download ZIP** herunterladen und entpacken.
2. In Chrome `chrome://extensions` öffnen und **Entwicklermodus** einschalten.
3. **Entpackte Erweiterung laden** anklicken und den Unterordner `extension/`
   aus dem entpackten Projekt auswählen.
4. Die Einstellungsseite öffnet sich nach der Installation automatisch.

Alternativ das fertige [Erweiterungspaket](dist/pokemon-center-check.zip)
herunterladen, entpacken und den entpackten Ordner laden. Darin liegt die
`manifest.json` direkt im Hauptverzeichnis.

Den geladenen Ordner anschließend nicht verschieben oder löschen. Nach Änderungen
am Code die Erweiterung in `chrome://extensions` über **Neu laden** aktualisieren.

## Telegram einrichten

Die Einstellungen erreichst du über das Symbol „Pokémon Center Check“ in Chromes
Erweiterungsmenü.

1. In Telegram bei [@BotFather](https://t.me/BotFather) mit `/newbot` einen Bot
   erstellen. Dessen Token lokal in der Erweiterung eintragen und speichern.
2. Deinem neuen Bot eine Nachricht schicken. In der Erweiterung **Chat-ID ermitteln**
   anklicken, deinen Chat auswählen und die Einstellungen erneut speichern.
   Die Suche setzt einen eigenen Bot ohne aktiven Webhook voraus.
3. **Telegram testen** sendet eine Testnachricht.
4. **Überwachung starten** prüft sofort und plant danach jeweils den nächsten
   zufälligen Termin. **Stoppen** hält die Überwachung an.

Token und Chat-ID gehören in die lokalen Einstellungen, nicht in den Chat oder
in den Quellcode. Ein leeres Tokenfeld behält einen bereits gespeicherten Token.

## Produkte und Zeitspanne einstellen

- Über **Produkt hinzufügen** bis zu zehn verschiedene Produktseiten eintragen.
  Jede benötigt eine URL und einen eindeutigen Teil der Produktüberschrift.
  **Nach oben**, **Nach unten** und **Entfernen** ändern die Liste.
- Unter **Von (Minuten)** und **Bis (Minuten)** die zufällige Pause wählen.
  Erlaubt sind 1 bis 1440 Minuten und höchstens zwei Nachkommastellen. Gleiche Werte
  ergeben einen festen Abstand. Ohne Änderung bleiben es 15 bis 30 Minuten.
- **Einstellungen speichern** übernimmt die Liste und Zeitspanne. Eine neue
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

## Verhalten

- Der vorhandene passende Produkttab wird bei jedem Check neu geladen. Fehlt er,
  öffnet die Erweiterung einen Hintergrundtab in derselben Chrome-Sitzung.
  Andere Tabs werden nicht geschlossen oder navigiert.
- Sie prüft einen sichtbaren, aktiven und nicht verdeckten Warenkorb-Button. Es wird
  nichts angeklickt oder gekauft. Die tatsächliche serverseitige Annahme einer
  Warenkorb-Anfrage wird damit nicht geprüft.
- Ladefehler, Schutzseiten und unklare Signale werden als Fehler angezeigt. Sie
  lösen keinen Verfügbarkeitsalarm aus und setzen den gespeicherten Alarmstatus
  nicht zurück. Fehlgeschlagener Telegram-Versand wird beim nächsten Check erneut
  versucht.
- Eine Meldung erfolgt für jedes Produkt getrennt bei erster bestätigter Verfügbarkeit und nach einem Wechsel
  von nicht verfügbar zu verfügbar. Ein Absturz genau zwischen Versand und
  Speicherung kann ausnahmsweise eine doppelte Meldung verursachen.
- Chrome und Rechner müssen laufen. Im Ruhezustand kann Chrome einen Termin
  verspäten; die Erweiterung weckt den Rechner nicht auf. Nach einem Browserneustart
  wird eine zuvor aktivierte Überwachung fortgesetzt.
- Die Einstellungsseite zeigt letzten Status, nächsten Termin, Fehler und die
  letzten Ereignisse. Sie muss für den Betrieb nicht geöffnet bleiben.
- Der Token wird ausschließlich im lokalen Erweiterungsspeicher gehalten und nur
  an die Telegram-API gesendet. Er wird weder an Pokémon Center noch an den
  Seiten-Prüfcode weitergegeben und nicht über Chrome Sync synchronisiert.
- Berechtigungen: lokaler Speicher, Chrome-Zeitplanung und das Auslesen des
  Pokémon-Center-Tabs; Netzwerkzugriff nur auf Pokémon Center und die Telegram-API.
- Für andere Produkte können URL und ein eindeutiger Teil der Produktüberschrift
  gespeichert werden. Unterstützt sind deutsche Pokémon-Center-Produktseiten.

## Entwicklung und Tests

Benötigt werden Node.js ab 22.9, npm und Python 3 für den ZIP-Build.
Nach dem Herunterladen des Projekts im Projektordner ausführen:

```bash
npm ci
npx playwright install --with-deps chromium
npm test
npm run build
```

Ist Google Chrome bereits installiert, können die Browser-Tests stattdessen
mit diesem Browser laufen:

```bash
BROWSER_CHANNEL=chrome npm test
```

Die letzte Variante verwendet eine eigene temporäre Testsitzung. Die Tests
greifen nicht auf die Einstellungen der in deinem Chrome installierten Erweiterung zu.

Die Tests liegen im Ordner `tests/`. Playwright wird ausschließlich als
Entwicklungsabhängigkeit für die Browser-Tests benötigt; die installierte
Erweiterung benötigt kein Node.js.

Die 51 Tests prüfen unter anderem DOM-Erkennung, verdeckte oder
fremde Buttons, Schutzseiten, Zufallsintervalle, Telegram-Fehler, doppelte Alarme,
parallele Prüfungen, Stop während laufender Arbeit und Wiederherstellung der
Zeitplanung nach Worker-Unterbrechungen. Zusätzlich werden die Grenze von zehn
Produkten, einstellbare Zeitspannen, Rotation über Fehler/Neustarts, getrennte
Benachrichtigungszustände und die Übernahme alter Einstellungen geprüft.
Die Tests senden keine echten Nachrichten.
Ein zusätzlicher Oberflächentest prüft Speicherhinweise, Schutz vor Prüfungen mit
ungespeicherten Produkten, fehlgeschlagene Speichervorgänge und Eingaben während
einer laufenden Anfrage.

GitHub Actions führt bei Pushes und Pull Requests die Tests unter Node.js 22 und 24
aus und baut das Erweiterungspaket. `npm run build` aktualisiert
`dist/pokemon-center-check.zip` aus den sechs Erweiterungsdateien und dieser
Anleitung. Lokale Einstellungen, Telegram-Zugangsdaten und Browserprofile sind
nicht Bestandteil des Pakets. Nach Änderungen am Code oder der Anleitung das
Paket vor dem Commit neu bauen.

## Projektstruktur

- `extension/`: Chrome-Erweiterung; dieser Ordner wird in Chrome geladen.
- `tests/`: Tests für Erkennung, Überwachung und Einstellungsseite.
- `scripts/package.py`: Erstellt das ZIP mit festgelegter Dateiliste.
- `.github/workflows/tests.yml`: Automatische Tests und ZIP-Build auf GitHub.
- `dist/pokemon-center-check.zip`: Erweiterung mit Anleitung zum Weitergeben.
- `package.json` und `package-lock.json`: Entwicklungs- und Testabhängigkeiten.

## Lizenz

Für dieses Projekt wurde bislang keine Lizenz festgelegt.

Referenzen: [Erweiterung lokal laden](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked),
[Chrome Alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms),
[Telegram Bot API](https://core.telegram.org/bots/api).
