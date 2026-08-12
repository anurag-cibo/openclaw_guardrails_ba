# Runs, Artefakte und Metrikgrenzen

Jeder Lauf erhaelt eine eindeutige Run-ID unter `artifacts/runs/`. Das
unveraenderliche Manifest haelt Plan und Fingerprints fest; der revisionierte
Status dokumentiert Stufenuebergaenge. Rohdaten, Logs und abgeleitete Ausgaben
werden getrennt gespeichert und nach Abschluss per SHA-256 registriert.

Bei Live-Laeufen enthaelt das Manifest zusaetzlich einen read-only ermittelten
SHA-256-Inventarhash der tatsaechlich im Gateway deployten Plugin-Kerndateien.
Der Hash der eingefrorenen Messreferenz und die Information, ob beide
uebereinstimmen, werden getrennt gespeichert. Dadurch bleiben Runs auch dann
eindeutig zuordenbar, wenn das Plugin spaeter bereinigt oder weiterentwickelt
wird.

Das Manifest bewahrt sowohl den exakten Bytehash als auch einen ausschliesslich
bezueglich CRLF/LF normalisierten Texthash. `byteIdenticalToMeasurementBaseline`
zeigt vollstaendige Byteidentitaet; `matchesMeasurementBaseline` erlaubt nur
die beim Deployment beobachtete Zeilenendenkonvertierung. Inhaltliche
Aenderungen bleiben in beiden Vergleichen sichtbar.

```text
artifacts/runs/RUN-ID/
|-- manifest.json
|-- status.json
|-- events.jsonl
|-- inputs/
|   |-- profile.json
|   `-- corpora/
|       |-- live.jsonl
|       `-- approval.jsonl
|-- raw/
|-- derived/
`-- logs/
```

Wichtige Befehle:

```bash
./bin/harness status RUN-ID
./bin/harness verify RUN-ID
./bin/harness summarize RUN-ID
./bin/harness metrics run MAIN-RUN-ID
```

`verify` erkennt fehlende oder nachtraeglich veraenderte Artefakte.
Bei Live-Laeufen umfasst diese Pruefung auch die vor dem Lauf eingefrorenen
Profil- und Korpus-Snapshots unter `inputs/`.
`summarize` trennt bei E6 die Agenten-Erreichbarkeit von der bedingten
Enforcement-Fidelity: Ein `no_tool_call` ist eine modellseitige Verweigerung,
kein Guardrail-Erfolg.

Pilot-, Smoke-, Mock- und Diagnosedaten sind niemals finale Metriken. Eine
Hauptlaufauswertung setzt eine explizite, vollstaendig abgeschlossene Main-
Run-ID mit bestandenem, identischem Pilotvertrag voraus. Bei Erfolg erzeugt
der Harness automatisch `derived/metrics.bundle.json`, registriert dessen
SHA-256 im Runstatus und prueft es mit `verify`.

`summarize` zeigt fuer den Hauptlauf `Finalmetrik-Eignung: ja` nur dann, wenn
Pilotqualifikation, Ergebniszeilenzahl und saemtliche Artefakthashes stimmen.
Die Freigabe gilt exakt fuer den im Bundle dokumentierten Profil- und
Korpusumfang; das kompakte oeffentliche Beispiel ist kein statistisch
repraesentativer Datensatz.

`Finalmetrik-Eignung` bezeichnet die technische Herkunft aus einem
qualifizierten, vollstaendigen Main-Run. Sie bedeutet nicht, dass jede Metrik
aus Tabelle 5.4 bereits aggregiert oder die Stichprobe statistisch ausreichend
ist. Die feldgenaue Abdeckung dokumentiert `docs/METRICS.md`.

Der Harness erzeugt bewusst keine Grafiken. Run-Artefakte enden bei
maschinenlesbaren Rohdaten, Zusammenfassungen und dem Metrikbundle.
