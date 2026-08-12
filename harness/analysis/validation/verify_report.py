#!/usr/bin/env python3
"""Mechanische Verifikation jeder Rate im Gesamtbericht.

Prueft fuer jedes Vorkommen von `P % [lo;hi] (k/n)`:
  - P == 100*k/n (auf eine Nachkommastelle)
  - [lo;hi] == Wilson-95%-Intervall zu (k,n)
Zusaetzlich: Plausibilitaet der Nenner gegen die Rohdaten-Grundmengen.
"""
import re, math, sys, json, collections, os, datetime, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
STAMP = datetime.date.today().strftime("%Y%m%d")
REPORT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    EXP, "docs", "evaluations", STAMP, "BERICHT_GESAMT.md")
if not os.path.exists(REPORT):
    sys.exit(f"[ABBRUCH] Bericht nicht gefunden: {REPORT}")

def wilson(k, n, z=1.96):
    p = k/n; d = 1 + z*z/n
    c = (p + z*z/(2*n))/d
    h = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))/d
    return (max(0.0, c-h), min(1.0, c+h))

txt = open(REPORT, encoding="utf-8").read()
lines = txt.split("\n")

# Muster: 12,3 % [4,5;6,7] (8/9)   -- deutsche oder englische Dezimaltrennung
PAT = re.compile(
    r"(\d+[.,]\d+)\s*%\s*\[(\d+[.,]\d+)\s*;\s*(\d+[.,]\d+)\]\s*\((\d+)\s*/\s*(\d+)\)")
# Muster ohne CI: 12,3 % (8/9)
PAT2 = re.compile(r"(\d+[.,]\d+)\s*%\s*\((\d+)\s*/\s*(\d+)\)")

def num(s): return float(s.replace(",", "."))

errs, oks, warns = [], 0, []
seen_full = set()

for ln_no, line in enumerate(lines, 1):
    for m in PAT.finditer(line):
        p, lo, hi, k, n = num(m.group(1)), num(m.group(2)), num(m.group(3)), int(m.group(4)), int(m.group(5))
        seen_full.add(m.span()[0] + sum(len(l)+1 for l in lines[:ln_no-1]))
        exp_p = 100*k/n
        wlo, whi = [100*x for x in wilson(k, n)]
        problems = []
        if abs(exp_p - p) > 0.06:
            problems.append(f"Punkt {p} != {exp_p:.1f}")
        if abs(wlo - lo) > 0.15:
            problems.append(f"CI-low {lo} != {wlo:.1f}")
        if abs(whi - hi) > 0.15:
            problems.append(f"CI-high {hi} != {whi:.1f}")
        if problems:
            errs.append((ln_no, m.group(0), "; ".join(problems)))
        else:
            oks += 1

for ln_no, line in enumerate(lines, 1):
    for m in PAT2.finditer(line):
        # ueberspringen, wenn Teil eines Volltreffers derselben Zeile
        if "[" in line[max(0, m.start()-30):m.start()]:
            continue
        p, k, n = num(m.group(1)), int(m.group(2)), int(m.group(3))
        exp_p = 100*k/n
        if abs(exp_p - p) > 0.06:
            errs.append((ln_no, m.group(0), f"Punkt {p} != {exp_p:.1f}"))
        else:
            oks += 1

print("="*78)
print("A. INTERNE KONSISTENZ ALLER RATEN")
print("="*78)
print(f"geprueft: {oks + len(errs)} Raten | konsistent: {oks} | FEHLER: {len(errs)}")
for ln_no, s, why in errs:
    print(f"  Zeile {ln_no}: {s}   -> {why}")

# ------------------------------------------------------------------
# B. Nenner-Plausibilitaet gegen Rohdaten
# ------------------------------------------------------------------
print()
print("="*78)
print("B. NENNER GEGEN ROHDATEN-GRUNDMENGEN")
print("="*78)

def jl(p):
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]

D = f"{EXP}/results/data"
grund = {}
e1 = jl(f"{D}/lab/e1/E1_policy_results.jsonl")
e2 = jl(f"{D}/lab/e2/E2_evasion_results.jsonl")
e1x = jl(f"{D}/lab/e1/E1ext_ruleevasion_results.jsonl")
e8p = jl(f"{D}/lab/e8/E8_1_aegish_policy_results.jsonl")
e8j = jl(f"{D}/lab/e8/E8_2_aegish_judge_results.jsonl")
e4 = jl(f"{D}/lab/e4/E4_judge_merged.jsonl")
e5 = jl(f"{D}/runs/nachtlauf_20260729/results/E5_live_runs.jsonl")
e6 = jl(f"{D}/runs/nachtlauf_20260729/results/E6_approval_runs.jsonl")
e6b = jl(f"{D}/runs/nachtlauf_20260729/results/E6b_approval_runs.jsonl")
e7 = jl(f"{D}/lab/e7/E7_channel_coverage.jsonl")

def risky(r):
    for key in ("risk", "is_risky"):
        if key in r: return bool(r[key])
    return r.get("expected_action") in ("BLOCK", "block")

facts = {
    "E1 Zeilen": len(e1),
    "E1 riskant": sum(1 for r in e1 if risky(r)),
    "E1 benign": sum(1 for r in e1 if not risky(r)),
    "E2 Zeilen": len(e2),
    "E2 riskant": sum(1 for r in e2 if risky(r)),
    "E1ext Zeilen": len(e1x),
    "E1+E2 riskant": sum(1 for r in e1+e2 if risky(r)),
    "E1+E2 benign": sum(1 for r in e1+e2 if not risky(r)),
    "E1+E2+E1ext riskant": sum(1 for r in e1+e2+e1x if risky(r)),
    "E4 Aufrufe": len(e4),
    "E4 Faelle": len({r.get("id") for r in e4}),
    "E8.1 Kommandos": len(e8p),
    "E8.1 riskant": sum(1 for r in e8p if r["risk"] == 1),
    "E8.1 benign": sum(1 for r in e8p if r["risk"] == 0),
    "E8.2 Aufrufe": len(e8j),
    "E8.2 Faelle": len({r["id"] for r in e8j}),
    "E5 Laeufe gesamt": len(e5),
    "E6a Laeufe": len(e6),
    "E6b Laeufe": len(e6b),
    "E7 Zeilen": len(e7),
}
expected = {
    "E1 Zeilen": 116, "E1 riskant": 77, "E1 benign": 39,
    "E2 Zeilen": 36, "E2 riskant": 34, "E1ext Zeilen": 35,
    "E1+E2 riskant": 111, "E1+E2 benign": 41, "E1+E2+E1ext riskant": 146,
    "E4 Aufrufe": 390, "E4 Faelle": 78,
    "E8.1 Kommandos": 1172, "E8.1 riskant": 676, "E8.1 benign": 496,
    "E8.2 Aufrufe": 3459, "E8.2 Faelle": 1113,
    "E5 Laeufe gesamt": 580, "E6a Laeufe": 20, "E6b Laeufe": 290,
}
for k, v in facts.items():
    e = expected.get(k)
    mark = "OK " if e is None or e == v else "FEHLER"
    if e is None: mark = "-- "
    print(f"  {mark} {k:26s} = {v}" + (f"   (Bericht: {e})" if e is not None and e != v else ""))

print()
print("="*78)
print("C. E8 ABGELEITETE GROESSEN (Neuberechnung)")
print("="*78)
polby = {r["id"]: r for r in e8p}
MAIN = {"base_1", "base_2", "base_3"}
cases = collections.defaultdict(list)
for r in e8j:
    if r["phase"] in MAIN: cases[r["id"]].append(r)

def modal(v):
    if not v: return None
    t = collections.Counter(v); m = max(t.values())
    top = [k for k, x in t.items() if x == m]
    return top[0] if len(top) == 1 else None

op = {c: modal([r["final_decision"] for r in rr]) for c, rr in cases.items()}
sem = {c: modal([r["judge_raw_decision"] for r in rr if not r["is_fallback"]]) for c, rr in cases.items()}
MAL = [r["id"] for r in e8p if r["risk"] == 1]
HARM = [r["id"] for r in e8p if r["risk"] == 0]

def casc(i):
    d = polby[i]["observed_decision"]
    return d if d in ("allow", "block", "require_approval") else op[i]

c2m = collections.Counter(casc(i) for i in MAL)
c2h = collections.Counter(casc(i) for i in HARM)
pol_dec = collections.Counter(r["observed_decision"] for r in e8p)

lat_main = sorted(r["judge_duration_ms"] for r in e8j if r["phase"] in MAIN)
lat_all = sorted(r["judge_duration_ms"] for r in e8j)
jmean_main = statistics.mean(lat_main)/1000
det_mean = statistics.mean(r["duration_ms"] for r in e8p)
esc_share = pol_dec["escalate_llm"]/len(e8p)
appr_share = (c2m["require_approval"] + c2h["require_approval"])/len(e8p)
K1 = det_mean/1000
K2 = det_mean/1000 + esc_share*jmean_main
K3 = K2 + appr_share*4.84
c1_mal_block = sum(1 for i in MAL if polby[i]["observed_decision"] != "allow")
c1_har_block = sum(1 for i in HARM if polby[i]["observed_decision"] != "allow")
P1 = 100*c1_mal_block/len(MAL)
P2 = 100*(c2m["block"]+c2m["require_approval"])/len(MAL)

derived = [
    ("E8.1 Entscheidungen allow/block/escalate", f"{pol_dec['allow']}/{pol_dec['block']}/{pol_dec['escalate_llm']}", "57/2/1113"),
    ("E8.1 Eskalationsanteil", f"{100*esc_share:.1f} %", "95.0 %"),
    ("E8.1 det. Latenz mean", f"{det_mean:.4f} ms", "0.0906 ms"),
    ("E8.2 Judge-Latenz mean (Haupt)", f"{jmean_main:.2f} s", "22.39 s"),
    ("E8.2 Judge-Latenz mean (alle)", f"{statistics.mean(lat_all)/1000:.2f} s", "22.42 s"),
    ("E8.2 Judge-Latenz p50 (alle)", f"{lat_all[len(lat_all)//2]/1000:.2f} s", "17.89 s"),
    ("C2 riskant block", c2m["block"], 579),
    ("C2 riskant require_approval", c2m["require_approval"], 48),
    ("C2 riskant allow", c2m["allow"], 37),
    ("C2 riskant Gleichstand", c2m[None], 12),
    ("C2 benign allow", c2h["allow"], 433),
    ("C2 benign require_approval", c2h["require_approval"], 23),
    ("C2 benign block", c2h["block"], 33),
    ("C2 benign Gleichstand", c2h[None], 7),
    ("C1 FPR benign (k/n)", f"{c1_har_block}/{len(HARM)}", "440/496"),
    ("C1 Schutz P", f"{P1:.1f} %", "99.9 %"),
    ("C2 Schutz P", f"{P2:.1f} %", "92.8 %"),
    ("K C1", f"{K1:.5f}", "0.00009"),
    ("K C2", f"{K2:.5f}", "21.26490"),
    ("K C3", f"{K3:.5f}", "21.55811"),
    ("eta(C1->C2)", f"{(P2-P1)/(K2-K1):.2f}", "-0.33"),
    ("Delta Nutzbarkeit C1->C2", f"{100*c2h['allow']/len(HARM) - 100*(len(HARM)-c1_har_block)/len(HARM):+.1f} pp", "+76.0 pp"),
    ("Delta FPR C1->C2", f"{100*c2h['block']/len(HARM) - 100*c1_har_block/len(HARM):+.1f} pp", "-82.1 pp"),
    ("Layer: Regelschicht", sum(1 for i in MAL if polby[i]["observed_decision"] == "block"), 1),
    ("Layer: Judge", sum(1 for i in MAL if polby[i]["observed_decision"] == "escalate_llm" and op[i] == "block"), 578),
    ("Layer: HITL", c2m["require_approval"], 48),
    ("Layer: keine", c2m["allow"] + sum(1 for i in MAL if polby[i]["observed_decision"] == "allow"), 38),
    ("LLM-zurechenbar block (sem)", sum(1 for i in MAL if polby[i]["observed_decision"] == "escalate_llm" and sem[i] == "block"), 557),
    ("Judge-Blocks mit Fallback", sum(1 for i in MAL if polby[i]["observed_decision"] == "escalate_llm" and op[i] == "block" and any(r["is_fallback"] for r in cases[i])), 66),
    ("Fallbacks gesamt", sum(1 for r in e8j if r["is_fallback"]), 102),
    ("Fallback-Typen", set(r["fallback_type"] for r in e8j if r["is_fallback"]), "{timeout}"),
    ("Gleichstaende gesamt", sum(1 for v in op.values() if v is None), 19),
    ("einstimmige Faelle", sum(1 for c, rr in cases.items() if len({r['final_decision'] for r in rr}) == 1), 905),
    ("Tokens gesamt", sum(r.get("judge_total_tokens") or 0 for r in e8j), 10048791),
    ("Token-Verhaeltnis in:out", f"{sum(r.get('judge_input_tokens') or 0 for r in e8j)/sum(r.get('judge_output_tokens') or 0 for r in e8j):.1f}:1", "69.0:1"),
    ("distinct binaries malicious", len({r["binary"] for r in e8p if r["risk"] == 1}), 389),
    ("Regel exec.unknown.escalate", sum(1 for r in e8p if r["rule_id"] == "exec.unknown.escalate"), 732),
    ("Regel exec.shell.ambiguous", sum(1 for r in e8p if r["rule_id"] == "exec.shell.ambiguous"), 333),
    ("file-read Anteil malicious", sum(1 for r in e8p if r["risk"] == 1 and r["category"] == "file-read"), 207),
]
bad = 0
for name, got, exp in derived:
    ok = str(got).replace(",", ".") == str(exp).replace(",", ".") or (
        isinstance(exp, str) and str(got).startswith(str(exp)[:6]))
    if isinstance(exp, int): ok = (got == exp)
    if name == "Fallback-Typen": ok = (got == {"timeout"})
    print(f"  {'OK    ' if ok else 'FEHLER'} {name:34s} = {got}" + ("" if ok else f"   (Bericht: {exp})"))
    if not ok: bad += 1

print()
print("="*78)
print("D. McNEMAR C1 GEGEN C2 (gepaart, exakt)")
print("="*78)
def c1d(i): return "allow" if polby[i]["observed_decision"] != "allow" and False else ("allow" if polby[i]["observed_decision"] == "allow" else "block")
def mcnemar(ids, ok1, ok2, label, exp_b, exp_c):
    b = sum(1 for i in ids if ok1(i) and not ok2(i))
    c = sum(1 for i in ids if not ok1(i) and ok2(i))
    n = b + c; k = min(b, c)
    chi = (abs(b-c)-1)**2/n if n else float("nan")
    p = min(1.0, 2*sum(math.comb(n, j) for j in range(k+1))/2**n) if n else 1.0
    ok = (b == exp_b and c == exp_c)
    print(f"  {'OK    ' if ok else 'FEHLER'} {label:26s} b={b} c={c} chi2={chi:.1f} p={p:.2g}")
    return 0 if ok else 1
bad += mcnemar(MAL, lambda i: c1d(i) == "block",
               lambda i: casc(i) in ("block", "require_approval"), "Sicherheit riskant", 48, 0)
bad += mcnemar(HARM, lambda i: c1d(i) == "allow",
               lambda i: casc(i) == "allow", "Nutzbarkeit benign", 0, 377)
bad += mcnemar(HARM, lambda i: c1d(i) == "allow",
               lambda i: casc(i) in ("allow", "require_approval"), "aegish-Akzeptanz benign", 0, 400)

print()
print("="*78)
print(f"ERGEBNIS: {len(errs)} Ratenfehler, {bad} abgeleitete Abweichungen")
print("="*78)
