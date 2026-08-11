# Guardrail Harness

Der Guardrail Harness fuehrt kurze, reproduzierbare Policy-, Judge- und
OpenClaw-Live-Tests aus. Eigene JSONL-Korpora und Profile bestimmen Faelle,
Modelle, Konfigurationen und Wiederholungen. Der Host benoetigt fuer die Kontrolllogik weder
Python noch Node.js: Beide Laufzeiten befinden sich in gepinnten
Docker-Images.

Diese Distribution enthaelt ausschliesslich kleine Beispielkorpora. Eigene
Forschungsdaten werden ueber `HARNESS_DATA_ROOT` read-only eingebunden und
muessen nicht in das Repository kopiert werden.

Ein eigener Live-Test besteht aus `live.jsonl`, optional `approval.jsonl` und
einem passenden Pilot-/Hauptprofil. Der vollstaendige, ausfuehrbare Ablauf und
die derzeit unterstuetzten Erfolgsprädikate stehen unter `docs/CORPORA.md` und
`docs/CONFIGURATION.md`.

## Voraussetzungen

- Linux x86-64 mit Bash
- Docker Engine und Docker Compose v2
- fuer Live-Laeufe: ein laufendes OpenClaw-Compose-Projekt mit installiertem
  Guardrail-Plugin, Ollama und dem im Profil angegebenen Modell

Der mitgelieferte E6a-Smoke setzt in der derzeit validierten Plugin-Version den
standardmaessig deaktivierten, auf eine feste Wegwerf-Fixture begrenzten
Testtreiber `guardrail_e6_exec` voraus. E5 und E6b verwenden ihn nicht. Details
und die Sicherheitsgrenze stehen unter `docs/SECURITY.md`.

## Quickstart ohne Live-System

```bash
chmod +x bin/harness bin/*.sh adapters/live/*.sh
./bin/harness runtime-build
./bin/harness runtime-check
./bin/harness profile validate profiles/live-smoke.example.json
./bin/harness live plan --profile profiles/live-smoke.example.json
./bin/harness offline pilot E1 E2 E3
./bin/harness judge pilot E4 --mock
```

Der Mock-Judge prueft nur den technischen Vertrag. Er ist nicht fuer
Hauptserien oder fachliche Metriken zugelassen.

## Kurzer Live-Smoke-Test

```bash
export OPENCLAW_REPO=/absoluter/pfad/zum/openclaw-repo
./bin/harness live preflight
./bin/harness live plugin-info
./bin/harness launch live pilot --profile profiles/live-smoke.example.json
./bin/harness jobs
./bin/harness job-log JOB-ID --follow
```

`Ctrl+C` beendet nur die Logansicht. Der mit `launch` gestartete Job laeuft von
der SSH-Sitzung entkoppelt weiter. Der oeffentliche Smoke-Test umfasst vier
E6a-Laeufe und benoetigte auf dem Validierungshost rund siebeneinhalb Minuten.
Die Laufzeit ist modell- und hostspezifisch.

`live plugin-info` ist read-only und zeigt den SHA-256-Inventarhash der
tatsaechlich deployten Plugin-Kerndateien sowie den Vergleich mit der
mitgelieferten Messreferenz. Der gleiche Wert wird vor jedem Live-Lauf in dessen
unveraenderliches Manifest aufgenommen.

Nach Abschluss:

```bash
./bin/harness job-status JOB-ID
./bin/harness verify RUN-ID
./bin/harness summarize RUN-ID
```

## Kompakter technischer Hauptlauf

Der Hauptlauf ist bewusst klein und profilgebunden. Pilot und Hauptlauf
verwenden denselben 20-Zeilen-Messvertrag (E5: 16, E6a: 4), erhalten aber
getrennte Run-IDs. Der Hauptlauf wird nur nach einem passenden, bestandenen
Pilot aus exakt derselben Distribution freigegeben.

```bash
./bin/harness launch live pilot --profile profiles/live-main-pilot.example.json
./bin/harness job-log JOB-ID --follow

./bin/harness launch live main --profile profiles/live-main.example.json \
  --pilot-run PILOT-RUN-ID
./bin/harness job-log JOB-ID --follow
```

Nach dem Hauptlauf werden Metriken automatisch erzeugt, registriert und durch
`verify` mitgeprueft:

```bash
./bin/harness verify MAIN-RUN-ID
./bin/harness summarize MAIN-RUN-ID
./bin/harness metrics run MAIN-RUN-ID
```

Die Resultate sind valide fuer genau diesen dokumentierten Profil- und
Korpusumfang. Das kleine Beispiel erhebt keinen statistischen
Repraesentativitaetsanspruch.

Das Bundle aggregiert unter anderem Tool-Call-/Refusal-, Model-Call-,
Eskalations-, Interventions-, Bypass-, Enforcement-, Harm-Prevention-, FPR-,
Task-Success- und Approval-Raten. Es enthaelt ausserdem Latenzstatistiken und,
soweit OpenClaw sie liefert, Tokenstatistiken. Jede Binomialmetrik enthaelt
Zaehler, Grundmenge und Wilson-95%-Intervall. Nicht erhobene Telemetrie bleibt
explizit `null`. Definitionen und Grenzen stehen unter `docs/METRICS.md`.

## Eigenen externen Korpus ausfuehren

Ein eigener Korpus muss nicht in das Repository. Der vollstaendige Ablauf ist:

1. Zwei UTF-8-JSONL-Dateien ausserhalb des Harness anlegen, beispielsweise
   `/mnt/data/mein-test/live.jsonl` und `/mnt/data/mein-test/approval.jsonl`.
   Auch wenn E6b nicht ausgewaehlt wird, erwartet Profilversion 1 beide
   Korpusangaben; dafuer kann eine sichere Approval-Fixture aus dem Beispiel
   uebernommen werden.
2. Ein Pilot-/Hauptprofilpaar im ignorierten Ordner `profiles/local/` anlegen
   und in beiden Profilen dieselben Korpora und dieselbe Matrix eintragen.
3. Die externe Datenwurzel und das OpenClaw-Repository als absolute Pfade
   exportieren.
4. Korpora, Fall-IDs, Fallzahlen, Arme und den errechneten Run-Plan validieren.
5. Pilot starten, mit `verify` und `summarize` pruefen und danach den identischen
   Hauptvertrag mit der Pilot-Run-ID starten.
6. Hauptlauf mit `verify`, `summarize` und `metrics run` pruefen.

```bash
cd /absoluter/pfad/Guardrail-Harness
mkdir -p profiles/local
cp profiles/live-main-pilot.example.json profiles/local/mein-pilot.json
cp profiles/live-main.example.json profiles/local/mein-main.json

# Beide JSON-Dateien bearbeiten:
# - corpora.live/root und corpora.approval/root auf "data" setzen
# - relative Korpuspfade und exakte Fallzahlen eintragen
# - matrix.* auf die eigenen IDs, Konfigurationen, Arme und reps anpassen
# - kind bleibt im Pilot "pilot" und im Hauptprofil "main"

export HARNESS_DATA_ROOT=/mnt/data/mein-test
export OPENCLAW_REPO=/absoluter/pfad/zum/openclaw-repo

./bin/harness profile validate profiles/local/mein-pilot.json
./bin/harness profile validate profiles/local/mein-main.json
./bin/harness live plan --profile profiles/local/mein-pilot.json
./bin/harness live plan --profile profiles/local/mein-main.json
./bin/harness live preflight

./bin/harness launch live pilot --profile profiles/local/mein-pilot.json
./bin/harness job-log PILOT-JOB-ID --follow
./bin/harness verify PILOT-RUN-ID
./bin/harness summarize PILOT-RUN-ID

./bin/harness launch live main --profile profiles/local/mein-main.json \
  --pilot-run PILOT-RUN-ID
./bin/harness job-log MAIN-JOB-ID --follow
./bin/harness verify MAIN-RUN-ID
./bin/harness summarize MAIN-RUN-ID
./bin/harness metrics run MAIN-RUN-ID
```

Vor jedem Run kopiert der Harness das validierte Profil und beide tatsaechlich
gelesenen Korpusdateien nach `artifacts/runs/RUN-ID/inputs/`. Diese Snapshots
werden mit SHA-256 registriert und von `verify` mitgeprueft. Der externe
Originalordner bleibt read-only eingebunden und unveraendert. Das genaue
JSONL-Format mit kopierbaren Einzelzeilen steht unter `docs/CORPORA.md`.

## Dokumentation

- [Konfiguration und Profile](docs/CONFIGURATION.md)
- [Korpusformate](docs/CORPORA.md)
- [Ausgaben und Metrikgrenzen](docs/OUTPUTS.md)
- [Metriken und Abdeckungsgrenzen](docs/METRICS.md)
- [Betriebsgrenzen und Sicherheit](docs/SECURITY.md)

Live-Laeufe veraendern temporaer die OpenClaw-Konfiguration. Der separate
Host-Runner erhaelt den Docker-Socket und damit praktisch Host-Rechte. Deshalb
ist vor jedem Live-Lauf der read-only Preflight verpflichtend.
