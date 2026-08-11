#!/usr/bin/env python3
"""Abbildung: Der LLM-Judge in drei Welten.

Zeigt Schutz- und Nutzbarkeitsachse derselben semantischen Schicht auf drei
unterschiedlich entstandenen Grundmengen. Traegt den Befund, dass die Schicht
dort wirkt, wo die Regelschicht abstiniert, und dort versagt, wo die Regel
bereits entschieden hat.

Datenquellen (keine hartkodierten Zahlen ausser den Nennern zur Kontrolle):
  docs/evaluations/<STAMP>/metriken.json        -> E4, Schritt 4
  docs/evaluations/e8/E8_2_aegish_judge_summary.json -> E8.2

Ausgabe: docs/figures/fig_judge_drei_welten.{pdf,png,svg}
"""
import json
import math
import os
import sys
import datetime

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
STAMP = os.environ.get("STAMP") or datetime.date.today().strftime("%Y%m%d")
EVAL = os.path.join(EXP, "docs", "evaluations", STAMP)
OUT = os.path.join(EXP, "docs", "figures")
os.makedirs(OUT, exist_ok=True)


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


# ---------------------------------------------------------------- Daten laden
mpath = os.path.join(EVAL, "metriken.json")
if not os.path.exists(mpath):
    sys.exit(f"[ABBRUCH] {mpath} fehlt. Zuerst build_evaluation.py laufen lassen.")
met = json.load(open(mpath, encoding="utf-8"))
e8 = json.load(open(os.path.join(
    EXP, "docs", "evaluations", "e8", "E8_2_aegish_judge_summary.json"), encoding="utf-8"))

# Welt 1 -- regelabgedeckte Eskalationen (E4, eigener Korpus)
byp = met["e4"]["judge_bypass"]              # riskant -> allow
ovb = met["e4"]["judge_overblock"]           # benign  -> block
w1_risk = (byp["n"] - byp["k"], byp["n"])    # gefangen = nicht durchgelassen
w1_ben = (ovb["n"] - ovb["k"], ovb["n"])     # erhalten = nicht geblockt

# Welt 2 -- regelerlaubte Umgehungen (Schritt 4, KONTRAFAKTISCH)
s4 = met["e4ext_hauptlauf"]
sc = "approve_all"
w2_anchor = (s4["anchor_allow"]["szenarien"][sc]["X_caught"],
             s4["anchor_allow"]["szenarien"][sc]["X_n"])
w2_neutral = (s4["neutral_escalate"]["szenarien"][sc]["X_caught"],
              s4["neutral_escalate"]["szenarien"][sc]["X_n"])
w2_ben = (s4["anchor_allow"]["szenarien"][sc]["benign_erhalten"],
          s4["anchor_allow"]["szenarien"][sc]["benign_n"])

# Welt 3 -- unabhaengige Eskalationen (E8.2, externer Korpus)
gi = e8["guardrail_safety_scoring"]["judge_malicious_intervention_conditional"]
ha = e8["primary_usability"]["judge_harmless_acceptance_conditional"]
w3_risk = (gi["k"], gi["n"])
w3_ben = (ha["k"], ha["n"])

# Kontrolle gegen den Bericht
assert (w1_risk, w1_ben) == ((48, 57), (21, 21)), (w1_risk, w1_ben)
assert (w2_anchor[1], w2_neutral[1]) == (32, 32)
assert (w3_risk, w3_ben) == ((626, 674), (400, 439)), (w3_risk, w3_ben)

# ---------------------------------------------------------------- Darstellung
plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 9,
    "axes.linewidth": 0.7,
    "xtick.major.width": 0.7,
    "ytick.major.width": 0.7,
})

C_RISK = "#3d3d3d"    # Schutzachse -- dunkel
C_BEN = "#b8b8b8"     # Nutzbarkeitsachse -- hell
C_EDGE = "#1a1a1a"

fig, axes = plt.subplots(1, 3, figsize=(9.2, 4.3), sharey=True,
                         gridspec_kw={"width_ratios": [1, 1.25, 1], "wspace": 0.12})

WELTEN = [
    dict(ax=0,
         titel="Welt 1\nregelabgedeckte\nEskalationen",
         quelle="E4 · eigener Korpus\n78 Fälle · 390 Aufrufe",
         kf=False,
         bars=[("riskante Fälle\ngefangen", w1_risk, C_RISK),
               ("benigne Fälle\nerhalten", w1_ben, C_BEN)]),
    dict(ax=1,
         titel="Welt 2\nregelerlaubte\nUmgehungen",
         quelle="Schritt 4 · eigener Korpus\n55 Fälle · 275 Aufrufe je Arm",
         kf=True,
         bars=[("riskante Fälle\ngefangen\n(Anker: allow)", w2_anchor, C_RISK),
               ("riskante Fälle\ngefangen\n(neutral)", w2_neutral, C_RISK),
               ("benigne Fälle\nerhalten", w2_ben, C_BEN)]),
    dict(ax=2,
         titel="Welt 3\nunabhängige\nEskalationen",
         quelle="E8.2 · externer Korpus\n1 113 Fälle · 3 459 Aufrufe",
         kf=False,
         bars=[("riskante Fälle\ngefangen", w3_risk, C_RISK),
               ("benigne Fälle\nerhalten", w3_ben, C_BEN)]),
]

for w in WELTEN:
    ax = axes[w["ax"]]
    n_bars = len(w["bars"])
    xs = range(n_bars)
    for x, (lab, (k, n), col) in zip(xs, w["bars"]):
        p = 100 * k / n
        lo, hi = [100 * v for v in wilson(round(k), n)]
        ax.bar(x, p, width=0.62, color=col, edgecolor=C_EDGE, linewidth=0.7,
               hatch="//" if w["kf"] else None, zorder=2)
        # Rundungsbedingt kann hi minimal unter p liegen (k == n) -> clampen
        ax.errorbar(x, p, yerr=[[max(0.0, p - lo)], [max(0.0, hi - p)]], fmt="none",
                    ecolor=C_EDGE, elinewidth=0.9, capsize=3.5, capthick=0.9, zorder=3)
        kt = f"{k:g}" if k != int(k) else f"{int(k)}"
        ax.text(x, hi + 3.0, f"{p:.1f} %".replace(".", ","), ha="center", va="bottom",
                fontsize=8.5, fontweight="bold", zorder=4)
        ax.text(x, 3.0, f"{kt}/{n}", ha="center", va="bottom",
                fontsize=7.5, color="white" if p > 14 else C_EDGE, zorder=4)

    ax.set_xticks(list(xs))
    ax.set_xticklabels([b[0] for b in w["bars"]], fontsize=7.6, linespacing=1.35)
    ax.set_xlim(-0.62, n_bars - 0.38)
    ax.set_ylim(0, 118)
    ax.set_yticks([0, 20, 40, 60, 80, 100])
    ax.grid(axis="y", color="#dcdcdc", linewidth=0.6, zorder=0)
    ax.set_axisbelow(True)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)

    ax.set_title(w["titel"], fontsize=9.5, fontweight="bold", linespacing=1.3, pad=26)
    ax.text(0.5, 1.015, w["quelle"], transform=ax.transAxes, ha="center", va="bottom",
            fontsize=7.3, color="#4a4a4a", linespacing=1.3)
    if w["kf"]:
        ax.text(0.5, -0.30, "KONTRAFAKTISCH — misst nicht das gebaute System",
                transform=ax.transAxes, ha="center", va="top", fontsize=7.6,
                fontweight="bold", color="#1a1a1a",
                bbox=dict(boxstyle="round,pad=0.35", facecolor="#ececec",
                          edgecolor=C_EDGE, linewidth=0.7))

axes[0].set_ylabel("Anteil der Fälle in Prozent", fontsize=9)

fig.legend(handles=[
    Patch(facecolor=C_RISK, edgecolor=C_EDGE, linewidth=0.7,
          label="Schutzachse — riskante Fälle geblockt oder eskaliert"),
    Patch(facecolor=C_BEN, edgecolor=C_EDGE, linewidth=0.7,
          label="Nutzbarkeitsachse — benigne Fälle nicht geblockt"),
    Patch(facecolor="white", edgecolor=C_EDGE, linewidth=0.7, hatch="//",
          label="kontrafaktische Anordnung"),
], loc="lower center", ncol=3, frameon=False, fontsize=7.9,
    bbox_to_anchor=(0.5, -0.015))

fig.subplots_adjust(left=0.075, right=0.985, top=0.74, bottom=0.30)

base = os.path.join(OUT, "fig_judge_drei_welten")
for ext in ("pdf", "png", "svg"):
    fig.savefig(f"{base}.{ext}", dpi=300 if ext == "png" else None,
                bbox_inches="tight", facecolor="white")
print("[geschrieben]", base + ".{pdf,png,svg}")
print(f"  Welt 1  riskant {w1_risk[0]}/{w1_risk[1]}   benign {w1_ben[0]}/{w1_ben[1]}")
print(f"  Welt 2  anchor {w2_anchor[0]:g}/{w2_anchor[1]}  neutral "
      f"{w2_neutral[0]:g}/{w2_neutral[1]}  benign {w2_ben[0]:g}/{w2_ben[1]}")
print(f"  Welt 3  riskant {w3_risk[0]}/{w3_risk[1]}  benign {w3_ben[0]}/{w3_ben[1]}")
