# Konfiguration und Profile

Ein Profil ist eine JSON-Datei, die den Lauf vollstaendig beschreibt. Sie
waehlt Experimente, Korpora, Modelle, Versuchsmatrix und begrenzte Retries. Vor
der Ausfuehrung wird das Profil validiert und zusammen mit den Korpus-Hashes in
den Ausfuehrungsfingerprint aufgenommen.

```bash
./bin/harness profile validate profiles/live-smoke.example.json
./bin/harness live plan --profile profiles/live-smoke.example.json
```

## Oberste Felder

| Feld | Bedeutung |
|---|---|
| `schemaVersion` | Derzeit exakt `1` |
| `name` | Stabiler Profilname ohne Leerzeichen |
| `kind` | `pilot` oder `main` |
| `experiments` | Auswahl aus `E5`, `E6a`, `E6b` |
| `corpora` | Live- und Approval-Korpus mit Fallzahl |
| `models` | Agentmodell, Judge-Modell und Judge-Endpunkt |
| `matrix` | Fall-IDs, Konfigurationen, Arme und Wiederholungen |
| `retry` | Begrenzte Wiederholungen fuer Gateway-Startfehler |

Das maschinenlesbare Schema liegt unter
`profiles/live-profile.schema.json`. `live-smoke.example.json` ist der kurze
Standardtest; `live-pilot.example.json` deckt E5, E6a und E6b mit 32 Zeilen ab.
`live-main-pilot.example.json` und `live-main.example.json` bilden denselben
kompakten 20-Zeilen-Vertrag fuer Pilot und Hauptlauf ab.

## Pilot-Gate fuer Hauptlaeufe

Ein Profil mit `"kind": "main"` kann nur mit einer expliziten Pilot-Run-ID
gestartet werden:

```bash
./bin/harness launch live main --profile profiles/live-main.example.json \
  --pilot-run PILOT-RUN-ID
```

Der Harness prueft vor der ersten Mutation, ob der Pilot abgeschlossen ist,
sein Technikgate bestanden hat und Messvertrag, Korpora, Adapter,
Kontrollcode, Runtime, Modelle sowie deployter Pluginstand uebereinstimmen.
Ein Smoke-Pilot mit kleinerer Matrix qualifiziert daher keinen Hauptlauf.

## Eigenes Pilot-/Hauptlaufpaar

Fuer eigene Korpora werden zwei Profile angelegt. Sie muessen denselben
Messvertrag beschreiben und unterscheiden sich nur in `name` und `kind`:

```bash
mkdir -p profiles/local
cp profiles/live-main-pilot.example.json profiles/local/mein-pilot.json
cp profiles/live-main.example.json profiles/local/mein-main.json
```

In beiden Dateien werden Korpuspfade, Modelle, Experimentauswahl und Matrix
identisch angepasst. Das Pilotprofil behaelt `"kind": "pilot"`, das
Hauptprofil `"kind": "main"`. Vor dem Start werden beide Plaene geprueft:

```bash
./bin/harness profile validate profiles/local/mein-pilot.json
./bin/harness profile validate profiles/local/mein-main.json
./bin/harness live plan --profile profiles/local/mein-pilot.json
./bin/harness live plan --profile profiles/local/mein-main.json
```

Nach dem abgeschlossenen Pilot wird dessen Run-ID explizit an den Hauptlauf
uebergeben. Bereits eine abweichende Fall-ID, Wiederholungszahl, Korpusdatei,
Runtime, Modell- oder Pluginversion sperrt das Gate.

## Private Korpora ausserhalb des Repositories

Im Profil wird je Korpus `"root": "data"` und ein relativer Pfad verwendet:

```json
"corpora": {
  "live": { "root": "data", "path": "live.jsonl", "cases": 4 },
  "approval": { "root": "data", "path": "approval.jsonl", "cases": 5 }
}
```

Auf dem Host wird nur die gemeinsame Datenwurzel gesetzt:

```bash
export HARNESS_DATA_ROOT=/mnt/data/meine-korpora
./bin/harness profile validate profiles/local/mein-pilot.json
```

Der Ordner wird read-only nach `/harness-data` gemountet. Absolute
Korpuspfade, `..`-Traversal, Backslashes und Symlink-Ausbrueche werden
abgewiesen. Plan und Manifest enthalten nur den logischen Containerpfad,
Fallzahl und SHA-256, niemals den privaten Hostpfad.

Beim Run-Start werden die nach dieser Pruefung tatsaechlich gelesenen Dateien
in das Run-Verzeichnis kopiert und gehasht. Der externe Ordner bleibt dabei
read-only; der Snapshot dient ausschliesslich der spaeteren Reproduktion.

## Matrix

- `E5`: `configs`, `caseIds`, `reps`, `c3ApprovalPolicy`
- `E6a`: `caseId`, `arms`, `reps`, `c2Reps`
- `E6b`: `caseIds`, `arms`, `reps`, `c2Reps`, `c2CaseId`

Erlaubte Konfigurationen sind `C0` bis `C3`; Approval-Arme sind `deny`,
`allow-once` und `timeout`. Der Plan berechnet vor dem Start die exakte Zahl
erwarteter Ergebniszeilen. Unbekannte Fall-IDs oder mit dem Korpus unvereinbare
Arme fuehren zum Abbruch.

## Modelle und Retries

`models.agent` und `models.judge` muessen auf dem Zielhost vorhanden sein.
`judgeBaseUrl` akzeptiert nur HTTP(S)-URLs ohne eingebettete Zugangsdaten.
Retries sind ausschliesslich fuer eng erkannte transiente Gateway-Startfehler
vorgesehen; fachliche Fehler werden nicht verdeckt.
