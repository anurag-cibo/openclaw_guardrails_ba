# Live-Profile

Ein Profil waehlt Experimente und Korpora, ohne Registry oder Harness-Code zu
aendern. Das mitgelieferte `live-pilot.example.json` verwendet ausschliesslich
die kleinen Pilotkorpora. Das Paar `live-main-pilot.example.json` und
`live-main.example.json` beschreibt denselben kompakten 20-Zeilen-Messvertrag:
16 E5- und vier E6a-Laeufe.

Lokale Forschungsprofile gehoeren nach `profiles/local/` und werden nicht
versioniert. Korpusdateien koennen unter `corpora/private/` beziehungsweise
`corpora/custom/` liegen oder aus einem vollstaendig externen Verzeichnis
read-only eingebunden werden.

```bash
./bin/harness profile validate profiles/live-pilot.example.json
./bin/harness live plan --profile profiles/live-pilot.example.json
./bin/harness launch live pilot --profile profiles/live-pilot.example.json
```

Fuer externe Daten wird im Profil je Korpus `"root": "data"` und ein relativer
Pfad gesetzt. Der Hostpfad steht ausschliesslich in `HARNESS_DATA_ROOT`:

```bash
export HARNESS_DATA_ROOT=/mnt/data/mein-projekt/harness-korpora
./bin/harness profile validate profiles/local/mein-pilot.json
./bin/harness live plan --profile profiles/local/mein-pilot.json
./bin/harness launch live pilot --profile profiles/local/mein-pilot.json
```

`HARNESS_DATA_ROOT` wird in Control- und Host-Runner unter `/harness-data`
read-only eingebunden. Deshalb bleibt `path` im Profil relativ, zum Beispiel
`"live.jsonl"` oder `"projekt-a/live.jsonl"`. Absolute Pfade, `..`-Ausbrueche
und Symlink-Ausbrueche werden abgewiesen. Das mitgelieferte
`live-pilot.data-root.example.json` demonstriert denselben Mechanismus mit den
oeffentlichen Pilotdateien; ohne gesetzte Variable verwendet der Harness
`corpora/` als Datenwurzel.

Beim Run-Start werden das validierte Profil sowie beide tatsaechlich gelesenen
Korpusdateien nach `artifacts/runs/RUN-ID/inputs/` kopiert, mit SHA-256
registriert und durch `verify` geprueft. Der externe Originalordner bleibt
read-only und wird nicht veraendert.

Unter `matrix` werden
Konfigurationen, Fall-IDs, Wiederholungen, Approval-Arme und C2-Kontrollen
festgelegt. `models` bestimmt Agent, Judge und Judge-Endpunkt; `retry` steuert
die begrenzten Phasen- und Gateway-Retries. Der Validator gleicht alle Fall-IDs
und Approval-Arme gegen die angegebenen Korpora ab und berechnet daraus die
erwartete Ergebniszeilenzahl. Ein Hauptlauf erfordert ein Profil mit
`"kind": "main"` und `--pilot-run RUN-ID`. Der Pilot muss abgeschlossen sein,
sein Technikgate bestanden haben und exakt denselben Messvertrag, Harnessstand,
Runtime-/Modellstand und deployten Pluginstand besitzen. Ein Smoke- oder
anderweitig abweichender Pilot wird abgewiesen.

```bash
./bin/harness launch live main --profile profiles/live-main.example.json \
  --pilot-run PILOT-RUN-ID
```
