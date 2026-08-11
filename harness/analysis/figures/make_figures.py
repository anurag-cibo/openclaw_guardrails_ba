#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_figures.py -- erzeugt die Abbildungen der Arbeit aus den Ergebnisdateien.
Liest docs/evaluations/generated/metrics/metrics_summary.json und
results/data/lab/e3/E3_latency.json. Schreibt PNG + PDF nach
docs/figures/generated/.

Abbildungen:
  fig_tradeoff       -- P(G) vs K(G) Scatter (zentrale Grafik, UF5)
  fig_rates          -- Bypass/FPR/Non-Block-Proxy je Konfiguration
  fig_bypass_heatmap -- Bypass je Risikoklasse x Konfiguration (UF2-Attribution)
  fig_decisions      -- effektive Entscheidungsverteilung je Konfiguration
  fig_latency        -- deterministische Latenz je Risikoklasse (E3)
"""
import json, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
METRICS = os.path.join(EXP, "docs", "evaluations", "generated", "metrics")
LATENCY = os.path.join(EXP, "results", "data", "lab", "e3", "E3_latency.json")
FIG = os.path.join(EXP, "docs", "figures", "generated")
os.makedirs(FIG, exist_ok=True)

def load(p, default=None):
    if not os.path.exists(p):
        return default
    with open(p, encoding="utf-8") as f:
        return json.load(f)

S = load(os.path.join(METRICS, "metrics_summary.json"), {})
LAT = load(LATENCY, {})
configs = ["C0", "C1", "C2", "C3"]
mock = S.get("inputs", {}).get("E4_mock", False)
banner = "  [Judge=MOCK]" if mock else ""

def save(fig, name):
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, name + ".png"), dpi=150)
    fig.savefig(os.path.join(FIG, name + ".pdf"))
    plt.close(fig)

# ---------- 1. Trade-off Scatter ----------
if S.get("tradeoff"):
    t = {x["config"]: x for x in S["tradeoff"]}
    fig, ax = plt.subplots(figsize=(6.5, 4.5))
    xs = [t[c]["K"] for c in configs]
    ys = [100*(t[c]["P"] or 0) for c in configs]
    ax.plot(xs, ys, "-o", color="#1f5fa8", markersize=9, zorder=3)
    for c in configs:
        ax.annotate(c, (t[c]["K"], 100*(t[c]["P"] or 0)),
                    textcoords="offset points", xytext=(8, -4), fontsize=11, weight="bold")
    ax.set_xlabel("Kostenmass K(G)  (Latenz / Tokens / Approval-Last, normiert)")
    ax.set_ylabel("Schutzmass P(G) = 1 - Bypass  [%]")
    ax.set_title("Sicherheits-Kosten-Trade-off der Konfigurationen" + banner)
    ax.grid(True, alpha=0.3)
    ax.set_ylim(-5, 105)
    save(fig, "fig_tradeoff")

# ---------- 2. Raten je Konfiguration ----------
if S.get("simulated"):
    sim = S["simulated"]
    def p(cfg, key):
        v = sim[cfg][key]["p"]; return 100*v if v is not None else 0
    bypass = [p(c, "bypass_rate") for c in configs]
    fpr = [p(c, "fpr") for c in configs]
    nonblock = [p(c, "non_block_rate_benign") for c in configs]
    import numpy as np
    x = np.arange(len(configs)); wd = 0.26
    fig, ax = plt.subplots(figsize=(7, 4.5))
    ax.bar(x - wd, bypass, wd, label="Bypass-Rate (riskant)", color="#c23b3b")
    ax.bar(x,      fpr,    wd, label="FPR (benign gestoert)", color="#e08a1e")
    ax.bar(x + wd, nonblock, wd, label="Non-Block-Rate benign (Proxy)", color="#2e8b57")
    ax.set_xticks(x); ax.set_xticklabels(configs)
    ax.set_ylabel("Rate [%]"); ax.set_ylim(0, 105)
    ax.set_title("Sicherheit vs. Nutzbarkeit je Konfiguration" + banner)
    ax.legend(fontsize=9); ax.grid(True, axis="y", alpha=0.3)
    save(fig, "fig_rates")

# ---------- 3. Bypass-Heatmap je Risikoklasse ----------
if S.get("bypass_by_class"):
    import numpy as np
    bc = S["bypass_by_class"]
    classes = [rc for rc in bc if any(bc[rc][c] for c in configs)]
    M = np.array([[ (bc[rc][c]["p"] if bc[rc][c] else np.nan)*100 for c in configs] for rc in classes])
    fig, ax = plt.subplots(figsize=(6.5, 0.5*len(classes)+1.5))
    im = ax.imshow(M, cmap="Reds", vmin=0, vmax=100, aspect="auto")
    ax.set_xticks(range(len(configs))); ax.set_xticklabels(configs)
    ax.set_yticks(range(len(classes))); ax.set_yticklabels(classes, fontsize=9)
    for i in range(len(classes)):
        for j in range(len(configs)):
            v = M[i, j]
            if not np.isnan(v):
                ax.text(j, i, f"{v:.0f}", ha="center", va="center",
                        color="white" if v > 55 else "black", fontsize=9)
    ax.set_title("Bypass-Rate [%] je Risikoklasse x Konfiguration (UF2)" + banner)
    fig.colorbar(im, ax=ax, label="Bypass [%]", fraction=0.046)
    save(fig, "fig_bypass_heatmap")

# ---------- 4. Entscheidungsverteilung ----------
if S.get("simulated"):
    import numpy as np
    sim = S["simulated"]
    cats = ["allow", "block", "require_approval"]
    colors = {"allow": "#2e8b57", "block": "#c23b3b", "require_approval": "#e08a1e"}
    fig, ax = plt.subplots(figsize=(7, 4.2))
    bottom = np.zeros(len(configs))
    for cat in cats:
        vals = [sim[c]["decision_distribution"].get(cat, 0) for c in configs]
        ax.bar(configs, vals, bottom=bottom, label=cat, color=colors[cat])
        bottom += np.array(vals)
    ax.set_ylabel("Anzahl Faelle"); ax.set_title("Effektive Entscheidungsverteilung je Konfiguration" + banner)
    ax.legend(fontsize=9); ax.grid(True, axis="y", alpha=0.3)
    save(fig, "fig_decisions")

# ---------- 5. Deterministische Latenz je Klasse (E3) ----------
if LAT.get("by_class_self"):
    bc = LAT["by_class_self"]
    classes = sorted(bc)
    means = [bc[c]["mean_ms"] for c in classes]
    p95 = [bc[c]["p95_ms"] for c in classes]
    import numpy as np
    x = np.arange(len(classes))
    fig, ax = plt.subplots(figsize=(7.5, 4.2))
    ax.bar(x, means, 0.6, color="#1f5fa8", label="mean")
    ax.plot(x, p95, "k.", label="p95")
    ax.set_xticks(x); ax.set_xticklabels(classes, rotation=40, ha="right", fontsize=8)
    ax.set_ylabel("Latenz [ms]")
    ov = LAT.get("overall_self", {})
    ax.set_title(f"Deterministische Guardrail-Latenz je Risikoklasse "
                 f"(gesamt mean={ov.get('mean_ms')}ms, p99={ov.get('p99_ms')}ms)")
    ax.legend(); ax.grid(True, axis="y", alpha=0.3)
    save(fig, "fig_latency")

print("Abbildungen geschrieben nach:", FIG)
for f in sorted(os.listdir(FIG)):
    print("  ", f)
