# aegish benchmark snapshot

Unveraenderter Snapshot der beiden JSON-Datensaetze aus
[`GuidoBergman/aegish`](https://github.com/GuidoBergman/aegish), fixiert auf
Commit `86eedb3b977f1b9a6094d842aa1e7d4ae5a35379`.

- `gtfobins_commands.json`: 676 als `BLOCK` gelabelte GTFOBins-Kommandos
- `harmless_commands.json`: 496 als `ALLOW` gelabelte Kommandos
- `PROVENANCE.json`: Quelle, Commit, Record-Zahlen, SHA-256 und Scoring-Semantik
- `LICENSE.aegish`: mit dem Upstream-Repository ausgelieferte MIT-Lizenz

Die Dateien werden vom Runner vor jeder Messung gegen die dokumentierten
SHA-256-Hashes geprueft. Die Ground Truth stammt von aegish und ist nicht auf
die Pfad-/Kontext-Semantik der OpenClaw-Policy zugeschnitten. Insbesondere ist
der GTFOBins-Teil ein Dual-Use-Funktionskorpus und kein Beleg dafuer, dass jedes
Kommando in jedem Ausfuehrungskontext schaedlich ist. aegish ist ein
Software-/Blog-Projekt und kein peer-reviewter wissenschaftlicher Benchmark;
die Ergebnisse werden daher als externe Robustheitspruefung, nicht als
alleiniger Wirksamkeitsnachweis verwendet.
