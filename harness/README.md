# Guardrail Experiment Harness — Neuaufbau

Status: kompakter profilgebundener Hauptlauf auf dem Linux-Zielhost validiert;
noch nicht in Git überführt.

Dieser Ordner ist die Arbeitskopie des Experiment-Harness. Die Experiment-Runner
liegen unter `runners/`, der für die Messungen maßgebliche Plugin-Stand unter
`vendor/plugin-baseline/` und die Auswertungspipeline unter `analysis/`. Diese
Bestandteile sind reguläre, gepflegte Komponenten des Harness. Ihre Inhalte
bleiben an den validierten Messstand gebunden und werden über ein
SHA-256-Inventar in `registry/snapshots.json` gegen unbemerkte Änderung
gesichert.

## Ziel

Der fertige Harness soll auf dem HAW-Host nur Bash, Docker und Docker Compose
voraussetzen. Weder Python noch Node.js sollen auf dem Host installiert sein
müssen. Die Laufzeiten werden später über ein festgelegtes Runtime-Image
bereitgestellt.

Der derzeit freigegebene Hauptlauf wird explizit und SSH-entkoppelt gestartet:

```bash
./bin/harness launch live main --profile profiles/live-main.example.json \
  --pilot-run PILOT-RUN-ID
```

Sein finaler Ablauf ist:

```text
doctor → Pilot → Pilotvalidierung → Hauptserie → Metriken → Prüfungen
```

Die vollständige Serie darf nur beginnen, wenn der Pilot mit demselben
Ausführungsfingerprint erfolgreich war. Metriken dürfen nur aus einem explizit
angegebenen, vollständigen Hauptlauf erzeugt werden.

## Vorgesehene Bedienoberfläche

```bash
./bin/harness doctor
./bin/harness list
./bin/harness plan --pilot
./bin/harness validate-corpus corpora/custom/mein_korpus.jsonl
./bin/harness offline pilot E1 E2 E3
./bin/harness judge pilot E4 --mock
./bin/harness live plan pilot E5 E6a E6b
./bin/harness profile validate profiles/live-pilot.example.json
./bin/harness profile validate profiles/live-smoke.example.json
./bin/harness live plan --profile profiles/live-pilot.example.json
./bin/harness live preflight
./bin/harness metrics reference
./bin/harness metrics run MAIN-RUN-ID
./bin/harness summarize RUN-ID
./bin/harness launch live pilot E5 E6a E6b
./bin/harness launch live pilot --profile profiles/live-pilot.example.json
./bin/harness launch live pilot --profile profiles/live-smoke.example.json
./bin/harness launch live pilot --profile profiles/live-main-pilot.example.json
./bin/harness launch live main --profile profiles/live-main.example.json --pilot-run PILOT-RUN-ID
./bin/harness jobs
./bin/harness job-status <job-id>
./bin/harness job-log <job-id> --follow
./bin/harness pilot
./bin/harness run E1 E4
./bin/harness all
./bin/harness status <run-id>
./bin/harness verify <run-id>
./bin/harness resume <run-id>
```

Aktuell implementiert und lokal testbar sind `doctor`, `list`, `plan`,
`prepare`, `validate-corpus`, `profile validate`, `offline`, `judge`,
`live plan`, `live pilot`, das profilgebundene `live main`, `metrics run`,
`status`, `verify` und `summarize`. `prepare` legt nur ein
isoliertes Run-Verzeichnis mit Manifest, Fingerprint, Status,
Ereignisprotokoll und Artefaktordnern an; es führt noch kein Experiment aus.
`offline` darf ausschließlich die freigegebenen E1-/E2-/E3-Adapter ausführen.
`live preflight` prüft Docker, Compose, OpenClaw-Dienste, Ollama-Modelle und die
fixierten Runtime-Images, ohne etwas zu verändern. Nach dem bestandenen
Zielhost-Preflight sind Live-Piloten und ein durch `--pilot-run` qualifizierter
Hauptlauf freigegeben. `run` und `all` bleiben gesperrt. Ein noch nicht
fertiger Befehl darf keinen scheinbar erfolgreichen Messlauf erzeugen.

Lokaler Aufruf während der Entwicklung:

```bash
node src/cli.mjs doctor
node src/cli.mjs list
node src/cli.mjs plan --pilot
node src/cli.mjs prepare pilot
node src/cli.mjs offline pilot E1 E2 E3
npm test
```

Auf einem Linux-/Docker-Host werden Diagnose und Runtime-Prüfung ohne lokal
installiertes Node.js oder Python über den Bash-Einstieg ausgeführt:

```bash
./bin/harness host-info
./bin/harness runtime-build
./bin/harness runtime-check
./bin/harness package-source
./bin/harness package-public
./bin/harness live plan pilot E5 E6a E6b
./bin/harness profile validate profiles/live-pilot.example.json
./bin/harness live plan --profile profiles/live-pilot.example.json
./bin/harness live preflight
```

Alle relativen `./bin/harness`-Aufrufe setzen voraus, dass das aktuelle
Verzeichnis der Harness-Ordner ist. Aus dem Home-Verzeichnis muss zuerst zum
übertragenen Harness gewechselt oder ein absoluter Pfad verwendet werden.
Der vorläufige, noch nicht für Git bestimmte SCP-Ablauf steht in
`docs/UNI_TRANSFER.md`.

Länger laufende Piloten und spätere Nachtläufe werden mit `launch` in einer
eigenen Session gestartet. `nohup` plus `setsid` entkoppeln sie von SSH. Das
Folgelog kann mit `job-log <job-id> --follow` angesehen werden; `Ctrl+C`
beendet dabei nur `tail`, nicht den Messjob.

Der kurze, fuer Aussenstehende vorgesehene Standardpfad ist
`profiles/live-smoke.example.json`. Er umfasst vier E6a-Laeufe und benoetigte
auf dem HAW-Validierungshost rund siebeneinhalb Minuten. Die bisherige
32-Zeilen-Matrix bleibt als erweiterter Technikpilot verfuegbar, ist aber nicht
der Standard-Quickstart. Der normale Hauptlauf ist mit 20 Ergebniszeilen
bewusst begrenzt; die historische 890-Zeilen-Rekonstruktion wird nicht als
normaler Produktlauf freigeschaltet.

`package-public` baut aus einer expliziten Allowlist einen separaten
Release-Kandidaten. Private Korpora, Forschungsreferenzen, Entwicklungsdocs,
Run-Artefakte, Imagearchive und zielhostspezifische Pfade werden dabei
automatisch ausgeschlossen. Das Paket erzeugt ein SHA-256-Dateimanifest und
enthaelt einen eigenen Selbsttest.

Private Live-/Approval-Korpora muessen nicht in den Harness kopiert werden. Ein
Profil mit `"root": "data"` referenziert sie relativ zu einer externen,
read-only eingebundenen Datenwurzel:

```bash
export HARNESS_DATA_ROOT=/absoluter/pfad/zu/meinen-korpora
./bin/harness profile validate profiles/local/mein-pilot.json
./bin/harness launch live pilot --profile profiles/local/mein-pilot.json
```

Im Container und in reproduzierbaren Plaenen erscheint nur
`/harness-data/<relativer-pfad>`; der private Hostpfad wird nicht in den Plan
geschrieben. Details und das ausfuehrbare Beispiel stehen in
`profiles/README.md`.

## Struktur

```text
Harness/
├── README.md
├── TEMP_KAPITEL4_NOTIZEN.md
├── bin/                    # Host-CLI
├── src/                    # Kontrollschicht
├── adapters/live/          # Live-Adapter mit Gateway-Bereitschaftspruefung
├── runners/                # Experiment-Runner (E5, E6b, Approval, Gateway)
├── vendor/plugin-baseline/ # gepinnter Plugin-Messstand
├── analysis/               # Auswertungspipeline (Python)
├── corpora/                # Beispiele, Schemata, Fixtures, private Korpora
├── profiles/               # öffentliche Beispiele und ignorierte lokale Profile
├── registry/               # Experimente, Korpora und Auswertungspipeline
├── docs/                   # Entwicklungs- und Provenienzdokumentation
├── tests/                  # Harness-Selbsttests
├── runtime/                # gepinnte, lokal validierte Container-Laufzeit
├── artifacts/runs/         # isolierte Ausgaben je Run-ID
└── reference/              # eingefrorene Vergleichsausgaben
```

## Harte Entwicklungsregeln

1. `runners/` und `vendor/plugin-baseline/` bleiben inhaltlich an den
   validierten Messstand gebunden; jede Änderung erfordert einen neuen Pilot.
2. Der historische Harness unter `../experiments/harness/` wird nicht bearbeitet.
3. Pilot-, Diagnose-, Mock- und Hauptdaten erhalten getrennte Run-Verzeichnisse.
4. Auswertung liest niemals durch implizite Suche aus mehreren Ergebnisordnern.
5. Jede Eingabe wird im Run-Manifest mit Pfad und SHA-256 dokumentiert.
6. Eine neue Implementierung ersetzt eine alte erst nach einem Golden-/Paritätstest.
7. Ein fehlgeschlagener Pflichtschritt verhindert die Metrikfreigabe.

`metrics reference` führt die aktuell autoritativen Golden-Ausgaben
deterministisch zusammen. Das Ergebnis ist ein Paritätsanker und markiert sich
selbst ausdrücklich als **keine** neue Harness-Hauptserie. Neue profilgebundene
Metriken werden nur aus einer expliziten, vollständigen Haupt-Run-ID akzeptiert.
Der Hauptlauf erzeugt `derived/metrics.bundle.json` automatisch und registriert
dessen SHA-256.

`summarize RUN-ID` ist die read-only Run-Diagnostik. Sie prüft zuerst alle
registrierten Artefakthashes und trennt für E6 Modell-Refusals, erreichte
Tool-/Approval-Läufe, valide Läufe und bedingte Enforcement-Fidelity. Bei
Piloten weist die Ausgabe ausdrücklich `Finalmetrik-Eignung: nein` aus; die
deskriptiven Pilotkennzahlen werden dennoch vollständig berechnet und bleiben
als technischer Validierungsnachweis erhalten.

`profile validate PROFIL.json` prüft einen vollständigen Live-Vertrag aus
Korpora, Modellen, Fall-/Konfigurationsmatrix und Retrygrenzen. Profil,
tatsächliche Korpus-Hashes sowie die neue Adapter-Schicht gehen in den
Ausführungsfingerprint ein. E5, E6a und E6b warten nach Gateway-Neustarts aktiv
auf eine erfolgreiche RPC-Probe; feste Wartezeiten sind keine
Bereitschaftsannahme der neuen Kontrollschicht mehr.

## Metrikpipeline

`compute_metrics.py` ist nicht mehr die maßgebliche Auswertung. Die aktuelle
Bachelorarbeit beruht auf einer Verbundpipeline aus `build_evaluation.py`, der
E8-Auswertung, der späteren E3-HAW-Auswertung und E5aeg. Die vollständige
Herleitung und der geplante Merge stehen in [docs/METRIKPIPELINE.md](docs/METRIKPIPELINE.md).

## Offline-Adapter und Korpusformat

Der Offline-Policy-Adapter führt keine Shell-Befehle aus. Er übergibt den im
Korpus gespeicherten Befehlsstring direkt an die eingefrorene
`evaluateExecPolicy`-Funktion und schreibt deren Klassifikation in ein
einheitliches JSONL-Ergebnis. E1 und E2 unterscheiden sich daher im Korpus,
nicht in der Guardrail-Implementierung. E3 misst dieselbe Funktion wiederholt
in frischen Node-Prozessen und benötigt ebenfalls kein Gateway, Modell oder
Netzwerk.

Das exakte JSONL-Format, Pflichtfelder und ein Minimalbeispiel stehen in
[docs/KORPUSFORMAT.md](docs/KORPUSFORMAT.md).

## Noch nicht erledigt

- abgabefähige finale Dokumentation statt interner Entwicklungsnotizen
- erst danach kontrollierte Git-Überführung und Einordnung in Kapitel 4
