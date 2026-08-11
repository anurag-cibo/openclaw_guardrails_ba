# Kommandoreferenz

Alle Aufrufe setzen voraus, dass das aktuelle Verzeichnis `harness/` ist.
`./bin/harness` ist der Bash-Einstieg und benötigt auf dem Host weder Python
noch Node.js. Während der Entwicklung lässt sich dieselbe Kontrollschicht auch
direkt mit `node src/cli.mjs …` aufrufen.

## Diagnose und Laufzeit

| Befehl | Wirkung | Verändert etwas |
|---|---|---|
| `./bin/harness host-info` | technische Hostdaten | nein |
| `./bin/harness runtime-build` | gepinntes Kontroll-Image bauen | lokale Images |
| `./bin/harness runtime-check` | Diagnose und Selbsttests im Container | nein |
| `./bin/harness doctor` | Registry, Korpus-Hashes, Runner-Inventar | nein |
| `./bin/harness list` | registrierte Experimente und Korpora | nein |

## Planung

| Befehl | Wirkung |
|---|---|
| `./bin/harness plan --pilot` | Pilotplan anzeigen |
| `./bin/harness plan --all` | vollständigen Plan anzeigen |
| `./bin/harness live plan pilot E5 E6a E6b` | Live-Plan aus der Registry |
| `./bin/harness live plan --profile P.json` | Live-Plan aus einem Profil |
| `./bin/harness profile validate P.json` | Profil und Korpora prüfen |
| `./bin/harness validate-corpus datei.jsonl` | Korpus gegen das Schema prüfen |

Ein Plan zeigt die erwartete Zeilenzahl. Weicht sie von Ihrer Erwartung ab,
stimmt die Matrix im Profil nicht.

## Offline-Experimente

Ohne Netzwerk, Gateway oder Modell.

```bash
./bin/harness offline pilot E1 E2 E3
./bin/harness offline main E1 E1ext E2 E3
```

## Judge-Experimente

```bash
./bin/harness judge pilot E4 --mock     # nur Vertragsprüfung
./bin/harness judge pilot E4            # echte Ollama-Aufrufe
./bin/harness judge resume <RUN-ID>     # abgebrochenen Lauf fortsetzen
```

`--mock` ist für fachliche Metriken gesperrt. Ein Mock-Lauf kann keine
Hauptserie qualifizieren.

## Live-Experimente

```bash
export OPENCLAW_REPO=/absoluter/pfad/zum/openclaw-repo

./bin/harness live preflight            # read-only Prüfung
./bin/harness live plugin-info          # deployter Plugin-Hash, read-only

./bin/harness launch live pilot --profile profiles/live-smoke.example.json
./bin/harness launch live main --profile profiles/live-main.example.json \
  --pilot-run <PILOT-RUN-ID>
```

`launch` entkoppelt den Lauf per `nohup` und `setsid` von der SSH-Sitzung.
Ohne `launch` läuft das Experiment im Vordergrund und stirbt mit der
Verbindung.

## Hintergrundjobs

| Befehl | Wirkung |
|---|---|
| `./bin/harness jobs` | alle Jobs mit PID und Exit-Code |
| `./bin/harness job-status <JOB-ID>` | Status eines Jobs |
| `./bin/harness job-log <JOB-ID> --follow` | Log mitlesen |

`Ctrl+C` beendet bei `--follow` nur die Anzeige, nicht den Messjob.

## Läufe prüfen und auswerten

| Befehl | Wirkung |
|---|---|
| `./bin/harness status` | alle Läufe |
| `./bin/harness status <RUN-ID> --json` | ein Lauf, maschinenlesbar |
| `./bin/harness verify <RUN-ID>` | alle Artefakthashes nachrechnen |
| `./bin/harness summarize <RUN-ID>` | Kennzahlen und Messklasse |
| `./bin/harness summarize <RUN-ID> --json` | dasselbe maschinenlesbar |
| `./bin/harness metrics run <MAIN-RUN-ID>` | Metrikbundle eines Hauptlaufs |
| `./bin/harness metrics reference` | Golden-Referenzbundle erzeugen |

`summarize` weist bei Piloten ausdrücklich `Finalmetrik-Eignung: nein` aus. Die
deskriptiven Kennzahlen werden trotzdem berechnet und bleiben als technischer
Nachweis erhalten.

`metrics reference` führt die eingefrorenen autoritativen Ausgaben unter
`reference/` deterministisch zusammen. Das Ergebnis ist ein Paritätsanker und
markiert sich selbst als **keine** neue Hauptserie.

## Distribution

| Befehl | Wirkung |
|---|---|
| `./bin/harness package-public` | eigenständiges öffentliches Paket bauen |
| `./bin/harness package-source` | vollständiges Quellpaket bauen |

`package-public` arbeitet mit einer harten Allowlist. Private Korpora,
Forschungsreferenzen, interne Notizen, Run-Artefakte und Imagearchive werden
ausgeschlossen; zusätzlich bricht der Bau ab, wenn zielhostspezifische Werte im
Ergebnis auftauchen. Das Paket enthält ein SHA-256-Dateimanifest und einen
eigenen Selbsttest.

## Umgebungsvariablen

| Variable | Bedeutung | Pflicht |
|---|---|---|
| `OPENCLAW_REPO` | absoluter Pfad zum OpenClaw-Compose-Projekt | für Live-Läufe |
| `HARNESS_DATA_ROOT` | externe, read-only eingebundene Korpuswurzel | optional |
| `MODEL` | Agentenmodell | nein, Profil hat Vorrang |
| `JUDGE_MODEL` | Judge-Modell | nein, Profil hat Vorrang |
| `JUDGE_BASE_URL` | Ollama-Endpunkt | nein |
| `CORPUS` | Korpuspfad für einen Einzellauf | nein |
| `OUTDIR` | Ausgabeverzeichnis eines Einzellaufs | nein |
| `DRY_RUN=1` | Runner zeigt Befehle, führt nichts aus | nein |

Profilwerte haben Vorrang vor Umgebungsvariablen. Der Host-Wrapper löst die
Profilmodelle vor dem Preflight auf, damit Prüfung und Ausführung nicht
unbemerkt verschiedene Modelle verwenden.

## Gesperrte Befehle

`harness pilot`, `harness run`, `harness all` und `harness resume` sind
absichtlich gesperrt. Ein unfertiger Befehl darf keinen scheinbar erfolgreichen
Messlauf erzeugen. Verwenden Sie stattdessen die oben dokumentierten Pfade.

## Entwicklung

```bash
npm test                      # vollständige Selbsttestsuite
node src/cli.mjs doctor       # Kontrollschicht ohne Bash-Einstieg
```

Unter Windows werden die Linux-spezifischen Job-, Lock- und Shell-Tests
übersprungen. Der maßgebliche Testlauf erfolgt in der Linux-Kontroll-Runtime
über `./bin/harness runtime-check`.
