# Referenzausgaben

Hier liegen ausschließlich kontrolliert übernommene Golden-Ausgaben. Sie dienen
Paritätstests und sind keine neuen Messergebnisse.

| Ordner | Inhalt |
|---|---|
| `core_20260806/` | Ausgabe von `build_evaluation.py`, E8-Vertiefung und damaliger Gesamtbericht |
| `e3_haw/` | spätere E3-Zielsystemauswertung, die E3-Windows überschreibt |
| `e4aeg/` | externe Policy-/Judge-Referenzsummaries |
| `e5aeg_archive/` | kontrolliert aus `haw_e5ext_20260807_175637.tar.gz` extrahierte Hauptserie und Auswertung |

Dateizahlen und kombinierte SHA-256-Inventare stehen in
`registry/snapshots.json`. Die E5aeg-Kopie enthält nur Manifest, Ergebnis-JSONL,
Summary und Report; die vielen einzelnen Rohdateien bleiben im unveränderten
Transferarchiv.
