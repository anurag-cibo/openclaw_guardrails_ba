# E3 – Policy-Latenz auf dem HAW-Zielsystem

Status: **5/5 Runden vollständig**  
Auswertungen: **1,740,000**  
Runtime: `v24.14.0` auf `linux/x64`  
Guardrail unverändert: **true**, Commit `9219828`

## HAW-Messung

Die Werte sind Rundenaggregate. `p50/p95/p99` sind jeweils der Median der fünf rundenweisen Perzentile.

| Messsicht | mean ms | p50 ms | p95 ms | p99 ms | Rundenbereich mean ms |
|---|---:|---:|---:|---:|---:|
| Policy-intern | 0.03592 | 0.034 | 0.05 | 0.067 | 0.0344–0.0388 |
| Wall Clock | 0.0363 | 0.0342 | 0.0504 | 0.0679 | 0.0348–0.0392 |

## Vergleich zur bisherigen Windows-Messung

| Messsicht | Metrik | Windows ms | HAW ms | HAW/Windows | Änderung |
|---|---|---:|---:|---:|---:|
| Policy-intern | mean | 0.0531 | 0.03592 | 0.676 | -32.4 % |
| Policy-intern | p50 | 0.052 | 0.034 | 0.654 | -34.6 % |
| Policy-intern | p95 | 0.061 | 0.05 | 0.820 | -18.0 % |
| Policy-intern | p99 | 0.076 | 0.067 | 0.882 | -11.8 % |
| Wall Clock | mean | 0.0539 | 0.0363 | 0.673 | -32.7 % |
| Wall Clock | p50 | 0.0528 | 0.0342 | 0.648 | -35.2 % |
| Wall Clock | p95 | 0.0617 | 0.0504 | 0.817 | -18.3 % |
| Wall Clock | p99 | 0.0774 | 0.0679 | 0.877 | -12.3 % |

## Interpretationsgrenze

Der Vergleich repliziert dieselbe Policy und denselben Korpus auf dem Zielstack. Betriebssystem, Node-Version und CPU-Umgebung ändern sich gemeinsam; die Differenz darf daher nicht kausal einer einzelnen Plattformkomponente zugeschrieben werden.
