# Analysecode

Die Skripte bleiben nach ihrem fachlichen Ansatz getrennt:

- `metrics/`: zentrale Metriken, konsolidierte Auswertung und Trade-off-Analyse.
- `figures/`: Erzeugung der Ergebnis- und Prüfgrafiken.
- `e8/`: E8.1/E8.2- und aegish-spezifische Vertiefung.
- `channels/`: Kanalabdeckung und Expositionsanalyse.
- `validation/`: Regressionstests gegen dokumentierte Ankerwerte.
- `_cache/`: erhaltene, generierte Python-Caches aus der früheren Struktur.

Die Skripte lesen standardmäßig aus `../data/` und schreiben abgeleitete
Artefakte nach `../../docs/evaluations/` oder `../../docs/figures/`.

Zentrale Auswertung:

```bash
cd experiments
python3 results/analysis/metrics/build_evaluation.py
python3 results/analysis/validation/verify_anchors.py
```

Legacy-Metrikpipeline und Abbildungen:

```bash
python3 results/analysis/metrics/compute_metrics.py
python3 results/analysis/figures/make_figures.py
```
