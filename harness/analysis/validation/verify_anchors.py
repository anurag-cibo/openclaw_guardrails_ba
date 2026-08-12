#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_anchors.py -- Regressionstest fuer build_evaluation.py.

Prueft die Ausgabe gegen unabhaengig dokumentierte Ankerwerte aus
docs/reports/methodology/UEBERGABE_Schritt4_und_Ablation_20260804.md und
docs/reports/methodology/NOTIZEN_Ablation_sensitive_aware_20260804.md.

Die Ankerwerte stammen NICHT aus diesem Auswertungspfad, sondern aus den
Laufprotokollen und der Vorabfestlegung. Ein Fehlschlag heisst: entweder
hat sich die Auswertungslogik still veraendert, oder eine Eingabedatei
wurde ausgetauscht.

Aufruf:
    python3 verify_anchors.py [PFAD/ZU/metriken.json]
Exit 0 = alle Pruefungen bestanden, sonst 1.
"""

import datetime
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
default = os.path.join(EXP, "docs", "evaluations",
                       f"{datetime.date.today():%Y%m%d}",
                       "metriken.json")
path = sys.argv[1] if len(sys.argv) > 1 else default

if not os.path.exists(path):
    sys.exit(f"[ABBRUCH] metriken.json nicht gefunden: {path}\n"
             f"  Zuerst build_evaluation.py laufen lassen.")

with open(path, encoding="utf-8") as fh:
    M = json.load(fh)

checks = []


def ck(name, got, exp, quelle):
    checks.append((got == exp, name, got, exp, quelle))


UE = "Uebergabe Schritt 4"
NO = "Notizen Ablation (Vorabfestlegung)"
PB = "Pruefbericht / E7-Befund"

# --- Regelschicht: die drei Grundmengen ---------------------------------
gm = M["c1_grundmengen"]
ck("C1-Bypass regelabgeleitet (E1+E2)",
   (gm["regelabgeleitet"]["bypass"]["k"], gm["regelabgeleitet"]["bypass"]["n"]),
   (0, 111), UE)
ck("C1-Bypass adversariell (E1ext)",
   (gm["adversariell"]["bypass"]["k"], gm["adversariell"]["bypass"]["n"]),
   (32, 35), UE)
ck("C1-Bypass kombiniert",
   (gm["kombiniert"]["bypass"]["k"], gm["kombiniert"]["bypass"]["n"]),
   (32, 146), "abgeleitet")

# --- Schritt 4, Hauptlauf ------------------------------------------------
h = M["e4ext_hauptlauf"]
ck("X anchor_allow (approve_all)",
   h["anchor_allow"]["szenarien"]["approve_all"]["X_caught"], 5, UE)
ck("X neutral_escalate (approve_all)",
   h["neutral_escalate"]["szenarien"]["approve_all"]["X_caught"], 8, UE)
ck("Fallback anchor_allow", h["anchor_allow"]["fallback"]["k"], 0, UE)
ck("Fallback neutral_escalate", h["neutral_escalate"]["fallback"]["k"], 0, UE)
ck("sensitive_basename_gap neutral_escalate",
   h["neutral_escalate"]["je_klasse"]["sensitive_basename_gap"]["gefangen"], 0, UE)
ck("grep_content_dump neutral_escalate",
   h["neutral_escalate"]["je_klasse"]["grep_content_dump"]["gefangen"], 0, UE)
ck("Armunterschied anchor vs. neutral",
   (M["ankereffekt_armdiff"]["n_unterschiedlich"], M["ankereffekt_armdiff"]["n"]),
   (8, 55), UE)
ck("durchgelassene FN als readonly eingestuft",
   M["e4ext_durchgelassen"]["readonly"]["k"], 247, UE)

# --- Ablation sensitive_aware -------------------------------------------
a = M["ablation"]
ck("K1: X sensitive_aware >= 10",
   a["sensitive_aware"]["szenarien"]["approve_all"]["X_caught"], 27, NO)
ck("gepaarter Arm neutral_escalate (Lauf 4)",
   a["neutral_escalate"]["szenarien"]["approve_all"]["X_caught"], 10, UE)
ck("K2: benigne Verluste (Kriterium verletzt)",
   a["sensitive_aware"]["szenarien"]["approve_all"]["benign_verloren"], 3, NO)
ck("K3: Grenzkontrollen geblockt",
   a["sensitive_aware"]["grenzkontrollen_geblockt"]["k"], 3, NO)
ck("sensitive_basename_gap sensitive_aware",
   a["sensitive_aware"]["je_klasse"]["sensitive_basename_gap"]["gefangen"], 12, UE)
ck("grep_content_dump sensitive_aware",
   a["sensitive_aware"]["je_klasse"]["grep_content_dump"]["gefangen"], 6, UE)
ck("find_write_primitive faellt auf 3/6",
   a["sensitive_aware"]["je_klasse"]["find_write_primitive"]["gefangen"], 3, UE)
ck("Fallback sensitive_aware erstmals > 0",
   a["sensitive_aware"]["fallback"]["k"], 1, UE)

# --- Wiederholbarkeit ----------------------------------------------------
ck("Modalwertwechsel anchor_allow", M["wiederholbarkeit"]["anchor_allow"], "4/55", UE)
ck("Modalwertwechsel neutral_escalate",
   M["wiederholbarkeit"]["neutral_escalate"], "4/55", UE)

# --- Kanalabdeckung ------------------------------------------------------
ck("E7 betroffene Sessions (korrigiert)",
   M["kanalabdeckung"]["betroffene_sessions"], 113, PB)
ck("E7 alte Tupelzaehlung (fehlerhaft)",
   M["kanalabdeckung"]["betroffene_tupel_alt"], 103, PB)

# --- Live ----------------------------------------------------------------
ck("Task Success C1 (balanciert)",
   round(M["live_balanciert"]["C1"]["task_success"]["p"], 3), 0.489, "Ergebniskapitel H4")
ck("Task Success C2 (balanciert)",
   M["live_balanciert"]["C2"]["task_success"]["p"], 1.0, "Ergebniskapitel H4")
ck("E6b geschuetztes Ziel unversehrt",
   M["approval_e6b"]["geschuetzt_intakt"]["p"], 1.0, UE)
ck("E6a: Feld nicht erhoben (kein 0/20-Artefakt)",
   M["approval_e6a"]["geschuetzt_intakt"], None, "Felddefinition E6a")

# --- Ausgabe -------------------------------------------------------------
bad = [c for c in checks if not c[0]]
width = max(len(c[1]) for c in checks)
for ok, name, got, exp, quelle in checks:
    print(("  OK  " if ok else "  !!  ") +
          f"{name:{width}s}  ist={got}  soll={exp}   [{quelle}]")

print(f"\n{len(checks) - len(bad)}/{len(checks)} Pruefungen bestanden.")
if bad:
    print("\nFEHLGESCHLAGEN:")
    for _, name, got, exp, quelle in bad:
        print(f"  - {name}: ist={got}, soll={exp} (Quelle: {quelle})")
    sys.exit(1)
print("Alle Ankerwerte reproduziert.")
