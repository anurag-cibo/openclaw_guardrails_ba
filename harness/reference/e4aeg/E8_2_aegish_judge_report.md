# E8.2 – aegish-Judge

> Nicht-kontrafaktische Messung: Alle 1.113 bewerteten Fälle werden von der
> produktiven deterministischen Policy tatsächlich als `escalate_llm` geroutet.

## Primärbefund: unabhängige benigne Nutzbarkeit

| Kennzahl | Ergebnis |
|---|---|
| C2-Kaskade: aegish-Akzeptanz auf allen 496 harmless-Fällen | 91.9% [89.2;94.0] (456/496) |
| Judge bedingt: aegish-Akzeptanz auf 439 erreichten harmless-Fällen | 91.1% [88.1;93.4] (400/439) |
| C2-Kaskade: reibungsfreies `allow` | 87.3% [84.1;89.9] (433/496) |
| Judge bedingt: reibungsfreies `allow` | 85.9% [82.3;88.8] (377/439) |

`require_approval` zählt in der aegish-Sicht bei harmless als akzeptiertes
`WARN`, aber nicht als reibungsfreie Freigabe.

## Getrennte Schutzsichten

| Sicht | malicious, gesamte Kaskade | malicious, Judge bedingt | LLM-zurechenbar ohne Fallback |
|---|---|---|---|
| aegish-native: nur `block` korrekt | 85.7% [82.8;88.1] (579/676) | 85.8% [82.9;88.2] (578/674) | 82.6% [79.6;85.3] (557/674) |
| E4-Sicherheit: `block` oder `require_approval` | 92.8% [90.5;94.5] (627/676) | 92.9% [90.7;94.6] (626/674) | 90.1% [87.6;92.1] (607/674) |

## Fallbacks und Stabilität

- Fallback-Aufrufe gesamt: 2.9% [2.4;3.6] (102/3459)
- Fälle mit mindestens einem Fallback in den drei Hauptreplikationen: 7.6% [6.2;9.3] (85/1113)
- Stabilitätsfälle 5/5 einstimmig: 44/60
- Modalwechsel von drei auf fünf Replikationen: 6/60

Fallback-Blocks werden in der operativen Entscheidung sichtbar, aber nie als
LLM-zurechenbarer Schutz gutgeschrieben.

## Telemetrie

- Judge-Aufrufe: 3459
- Input-Tokens gesamt: 9905221
- Output-Tokens gesamt: 143570
- Tokens gesamt: 10048791
- Judge-Latenz p50/p95: 17893.8/52554.9 ms

Manifest: `<messumgebung>/experiments/results/data/lab/e8/E8_2_aegish_judge_manifest.json`
Rohdaten: `<messumgebung>/experiments/results/data/lab/e8/E8_2_aegish_judge_results.jsonl`
