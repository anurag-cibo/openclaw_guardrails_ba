# Guardrail Experiment Harness

Der Harness führt die Experimente aus, mit denen das Guardrail-Plugin dieses
Repositories bewertet wird: deterministische Policy-Messungen, LLM-Judge-Läufe
und End-to-End-Läufe gegen ein echtes OpenClaw-Gateway.

Jeder Lauf erhält ein eigenes Verzeichnis mit unveränderlichem Manifest,
Rohdaten, Logs und per SHA-256 registrierten Artefakten. Ein Hauptlauf wird nur
nach einem bestandenen Piloten mit identischem Messvertrag freigegeben.

**Für die Kontrolllogik werden auf dem Host weder Python noch Node.js benötigt.**
Beide Laufzeiten stecken in gepinnten Docker-Images.

## Experimente

| ID | Gegenstand | Braucht Live-System |
|---|---|---|
| E1 | Policy-Charakterisierung auf dem Policy-Korpus | nein |
| E1ext | Regelumgehung | nein |
| E2 | Robustheit und Evasion | nein |
| E3 | Deterministischer Laufzeit-Overhead | nein |
| E4 | LLM-Judge-Charakterisierung | nur Ollama |
| E5 | End-to-End-Läufe über die Konfigurationen C0–C3 | ja |
| E6a | Approval-Lifecycle über den Testtreiber | ja |
| E6b | Approval über das Core-Werkzeug `exec` | ja |

E1 bis E3 laufen ohne Netzwerk, Gateway oder Modell. Damit lässt sich die
Installation vollständig prüfen, bevor ein Live-System nötig wird.

---

# Teil 1 — Voraussetzungen

## Host

- Linux x86-64 mit Bash
- Docker Engine
- Docker Compose v2 (`docker compose version` muss funktionieren)
- Zugriff auf den Docker-Socket
- rund 2 GB Plattenplatz für die Laufzeit-Images

Geprüft und freigegeben ist ausschließlich Linux x86-64. macOS und Windows sind
nicht freigegeben; unter Windows lässt sich die Entwicklungstestsuite ausführen,
die Live-Experimente nicht.

## Zusätzlich für Live-Experimente (E5, E6a, E6b)

- ein lauffähiges **OpenClaw-Compose-Projekt** mit den Dateien
  `docker-compose.yml` und `docker-compose.ollama.override.yml`
- der Dienst `openclaw-gateway`, erreichbar unter `http://127.0.0.1:18789/healthz`
- ein **Ollama**-Dienst im selben Compose-Projekt
- das im Profil angegebene Modell, standardmäßig `qwen3:30b`
- das Guardrail-Plugin dieses Repositories im Gateway installiert

Die validierte Kombination ist OpenClaw 2026.5.18 mit `qwen3:30b` für Agent und
Judge. Das Bezugs- und Installationsverfahren für OpenClaw selbst gehört nicht
zu diesem Repository.

**Zum Speicherbedarf:** Agent und Judge verwenden dasselbe Modell. Auf der
Validierungshardware (GRID V100S-32Q, 32 GB VRAM) war das notwendig — ein
größeres Agentenmodell neben dem Judge führte zu CUDA-OOM. Wer mehr VRAM hat,
kann Agent- und Judge-Modell im Profil trennen.

---

# Teil 2 — Installation prüfen, ohne Live-System

Diese vier Schritte funktionieren auf jedem Docker-Host und brauchen weder
OpenClaw noch ein Modell.

## Schritt 1: Ausführungsrechte setzen

```bash
cd harness
chmod +x bin/harness bin/*.sh adapters/live/*.sh runners/*.sh
```

## Schritt 2: Kontroll-Runtime bauen

```bash
./bin/harness runtime-build
./bin/harness runtime-check
```

`runtime-build` baut das gepinnte Kontroll-Image. `runtime-check` führt
Diagnose und Selbsttests **innerhalb** des Containers aus. Beides verändert
nichts an einem OpenClaw-System.

## Schritt 3: Diagnose

```bash
./bin/harness doctor
```

Erwartet wird `Registry: ok` sowie ein Runner-Inventar, dessen SHA-256 mit dem
in `registry/snapshots.json` registrierten Wert übereinstimmt.

## Schritt 4: Erster echter Messlauf

```bash
./bin/harness offline pilot E1 E2 E3
./bin/harness judge pilot E4 --mock
```

Der Offline-Pilot klassifiziert Korpusfälle mit der eingefrorenen Policy und
misst den deterministischen Overhead. Der Mock-Judge prüft nur den technischen
Vertrag und ist für fachliche Metriken **nicht** zugelassen.

Beide Läufe legen ein Verzeichnis unter `artifacts/runs/` an. Prüfen:

```bash
./bin/harness status
./bin/harness verify <RUN-ID>
./bin/harness summarize <RUN-ID>
```

Wenn `verify` die Integrität bestätigt, ist die Installation vollständig
funktionsfähig.

---

# Teil 3 — Live-System vorbereiten

## Schritt 5: OpenClaw-Repo bekanntmachen

Alle Live-Befehle brauchen den absoluten Pfad zum OpenClaw-Compose-Projekt.
Es gibt bewusst keinen Standardwert:

```bash
export OPENCLAW_REPO=/absoluter/pfad/zum/openclaw-repo
```

## Schritt 6: Gateway und Ollama starten

```bash
cd "$OPENCLAW_REPO"
docker compose -f docker-compose.yml -f docker-compose.ollama.override.yml up -d ollama openclaw-gateway
curl -fsS http://127.0.0.1:18789/healthz
```

## Schritt 7: Modell laden

```bash
docker compose -f docker-compose.yml -f docker-compose.ollama.override.yml \
  exec ollama ollama pull qwen3:30b
```

## Schritt 8: Guardrail-Plugin deployen

Aus dem **Repository-Wurzelverzeichnis**, nicht aus `harness/`:

```bash
cd ..
OPENCLAW_REPO=/absoluter/pfad/zum/openclaw-repo ./scripts/deploy.sh
```

Das Skript kopiert die Plugin-Quelle nach
`/home/node/.openclaw/local-plugins/guardrail-spike`, startet das Gateway neu
und verifiziert die Dateien im Container.

Die Plugin-Kennung lautet `guardrail-spike` — nicht wie das Repository. Alle
Konfigurationsschlüssel heißen entsprechend
`plugins.entries.guardrail-spike.*`.

## Schritt 9: Read-only Preflight

```bash
cd harness
./bin/harness live preflight
./bin/harness live plugin-info
```

`live preflight` prüft Plattform, Docker, Compose, Socket-Rechte,
Image-Identität, OpenClaw-Dienste und die Modelle. Es **verändert nichts**.
Solange dieser Befehl nicht fehlerfrei durchläuft, bleibt die Live-Ausführung
gesperrt.

`live plugin-info` zeigt den SHA-256 der tatsächlich deployten Plugin-Dateien
und vergleicht ihn mit der mitgelieferten Messreferenz. Derselbe Wert wird in
jedes Run-Manifest geschrieben.

---

# Teil 4 — Live-Experimente

## Schritt 10: Kurzer Smoke-Test

Vier E6a-Läufe, auf dem Validierungshost rund siebeneinhalb Minuten:

```bash
./bin/harness launch live pilot --profile profiles/live-smoke.example.json
./bin/harness jobs
./bin/harness job-log <JOB-ID> --follow
```

`launch` startet den Lauf mit `nohup` in einer eigenen `setsid`-Session. Er
überlebt einen SSH-Abbruch. `Ctrl+C` beendet bei `job-log --follow` nur die
Logansicht, nicht den Messjob.

Nach Abschluss:

```bash
./bin/harness job-status <JOB-ID>
./bin/harness verify <RUN-ID>
./bin/harness summarize <RUN-ID>
```

E6a braucht das im Plugin standardmäßig **deaktivierte** Testwerkzeug
`guardrail_e6_exec`. Der Adapter aktiviert es nur für die Dauer von E6a und
stellt den vorherigen Wert danach wieder her. Die Sicherheitsgrenze steht in
[docs/SECURITY.md](docs/SECURITY.md). E5 und E6b brauchen es nicht.

## Schritt 11: Hauptlauf

Pilot und Hauptlauf verwenden denselben 20-Zeilen-Messvertrag (E5: 16,
E6a: 4), bekommen aber getrennte Run-IDs. Der Hauptlauf wird nur nach einem
passenden, bestandenen Piloten freigegeben.

```bash
./bin/harness launch live pilot --profile profiles/live-main-pilot.example.json
./bin/harness job-log <JOB-ID> --follow

./bin/harness launch live main \
  --profile profiles/live-main.example.json \
  --pilot-run <PILOT-RUN-ID>
./bin/harness job-log <JOB-ID> --follow
```

Auf dem Validierungshost dauerte jede der beiden Phasen rund 28 Minuten.

Das Gate vergleicht Messmatrix, Korpus-Hashes, Adapter-, Kontroll- und
Runtimestand, Modelle sowie den normalisierten Hash des deployten Plugins. Ein
abweichender oder unvollständiger Pilot wird vor dem Start abgewiesen.

---

# Teil 5 — Ergebnisse

Nach einem qualifizierten Hauptlauf entstehen die Metriken automatisch:

```bash
./bin/harness verify <MAIN-RUN-ID>
./bin/harness summarize <MAIN-RUN-ID>
./bin/harness metrics run <MAIN-RUN-ID>
```

Ablage je Lauf:

```text
artifacts/runs/<RUN-ID>/
├── manifest.json          unveränderlich: Plan, Eingaben, Fingerprints
├── status.json            revisionierter Stufenstatus
├── events.jsonl           Ereignisprotokoll
├── inputs/                eingefrorenes Profil und Korpuskopien
├── raw/                   Rohdaten je Experiment
│   └── E5/E5_live_runs.jsonl
├── derived/               Auswertung
│   └── metrics.bundle.json
└── logs/
```

Die Rohdatenformate entsprechen denen der ursprünglichen Messreihen: eine
JSONL-Zeile je Lauf, dazu Gateway-Logdelta und Dateisystemzustand, erzeugt vom
selben Auswerter `runners/evaluate_live_run.py`.

`metrics.bundle.json` ist die maschinenlesbare Quelle. Jede Binomialmetrik
enthält Zähler, Grundmenge, Rate und Wilson-95%-Intervall; nicht erhobene
Telemetrie bleibt ausdrücklich `null` und wird nie als Null interpretiert.
Definitionen stehen in [docs/METRICS.md](docs/METRICS.md).

Grafikerzeugung gehört bewusst nicht zum Funktionsumfang. Die Schnittstelle
endet beim validierten Metrikobjekt.

---

# Teil 6 — Eigene Korpora

Eigene Forschungsdaten müssen nicht in das Repository. Eine externe Datenwurzel
wird read-only unter `/harness-data` eingebunden:

```bash
export HARNESS_DATA_ROOT=/absoluter/pfad/zu/meinen-korpora
./bin/harness profile validate profiles/local/mein-pilot.json
./bin/harness launch live pilot --profile profiles/local/mein-pilot.json
```

Profile mit `"root": "data"` referenzieren nur relative Pfade. Absolute Pfade,
Traversal und Symlink-Ausbrüche werden abgewiesen; Pläne und Manifeste
enthalten den privaten Hostpfad nicht. Lokale Profile unter `profiles/local/`
sind von der Versionierung ausgenommen.

Format, Pflichtfelder und ein kopierbares Beispiel stehen in
[docs/CORPORA.md](docs/CORPORA.md), die Profilstruktur in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Korpus vorab prüfen:

```bash
./bin/harness validate-corpus /pfad/zu/meinem_korpus.jsonl
```

---

# Troubleshooting

**`./bin/harness: No such file or directory`** — Sie stehen nicht im
`harness/`-Verzeichnis. Alle relativen Aufrufe setzen das voraus.

**`OPENCLAW_REPO muss als absoluter Pfad gesetzt sein`** — Erwartetes
Verhalten. Es gibt keinen Standardpfad; siehe Schritt 5.

**Preflight meldet fehlende Image-Identität** — Das Laufzeit-Image wurde auf
diesem Host noch nicht gebaut oder importiert. Siehe Schritt 2.

**E6a scheitert unmittelbar nach einem Gateway-Neustart** — Der Adapter prüft
die Gateway-Bereitschaft aktiv per RPC und wiederholt eng klassifizierte
Startfehler. Halten die Fehler an, prüfen Sie
`docker compose logs openclaw-gateway`.

**Ein zweiter Live-Lauf wird mit Exit-Code 4 abgewiesen** — Live-Läufe haben
eine exklusive Sperre. Parallele Läufe würden dieselbe Gateway-Konfiguration
gleichzeitig verändern.

**Viele `no_tool_call`-Zeilen** — Das Modell hat den Werkzeugaufruf verweigert.
Das ist eine fehlende Erreichbarkeit, kein Guardrail-Erfolg, und wird in der
Auswertung getrennt ausgewiesen.

---

# Weiterführende Dokumentation

- [docs/COMMANDS.md](docs/COMMANDS.md) — vollständige Kommandoreferenz
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — Profile und Konfiguration
- [docs/CORPORA.md](docs/CORPORA.md) — Korpusformate und Erfolgsprädikate
- [docs/METRICS.md](docs/METRICS.md) — Metrikdefinitionen und Grenzen
- [docs/OUTPUTS.md](docs/OUTPUTS.md) — Runs, Artefakte und Provenienz
- [docs/SECURITY.md](docs/SECURITY.md) — Betriebsgrenzen und Limitationen

# Aussagegrenzen

Die mitgelieferten Beispielkorpora sind klein. Ein Lauf mit ihnen ist ein
technischer Funktionsnachweis und **keine statistisch belastbare Messreihe**.
Die Metriken gelten exakt für Profil, Korpora, Modelle, Pluginstand und Matrix
des jeweiligen Laufs.

Modellinferenz bleibt trotz `temperature=0` nicht vollständig deterministisch.
Live-Läufe verändern und starten das OpenClaw-Gateway neu; der Host-Runner
benötigt den Docker-Socket, was praktisch Host-Rechten entspricht.
