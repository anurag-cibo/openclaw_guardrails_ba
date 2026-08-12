#!/usr/bin/env node
// run_policy_offline.mjs -- E1/E2: fuehrt einen JSONL-Korpus direkt gegen den
// echten deterministischen Layer (policy.js) des Plugins aus. Kein Server noetig.
//
// Nutzung:
//   node run_policy_offline.mjs ../corpus/policy_corpus.jsonl ../results/data/lab/e1/E1_policy_results.jsonl
//   node run_policy_offline.mjs ../corpus/evasion_corpus.jsonl ../results/data/lab/e2/E2_evasion_results.jsonl
//
// Plugin-Quelle ueber Umgebungsvariable ueberschreibbar:
//   GUARDRAIL_SRC=/pfad/zu/src node run_policy_offline.mjs ...
//
// Ground-Truth-Semantik siehe corpus/build_corpus.py.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = "/home/node/.openclaw/workspace";

const srcDir = process.env.GUARDRAIL_SRC
  ? resolve(process.env.GUARDRAIL_SRC)
  : resolve(__dirname, "../../guardrail-plugin/openclaw_guardrails_ba/src");
const policyUrl = pathToFileURL(resolve(srcDir, "policy.js")).href;
if (!existsSync(resolve(srcDir, "policy.js"))) {
  console.error(`policy.js nicht gefunden unter ${srcDir}. GUARDRAIL_SRC setzen.`);
  process.exit(2);
}
const { evaluateExecPolicy } = await import(policyUrl);

const inPath = process.argv[2] ?? resolve(__dirname, "../corpus/policy_corpus.jsonl");
const outPath = process.argv[3] ?? resolve(__dirname, "../results/data/lab/e1/E1_policy_results.jsonl");

const rows = readFileSync(inPath, "utf8")
  .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

// Effektive Entscheidung unter C1 (det-only, kein HITL): Nur allow wird
// ausgefuehrt; block, require_approval und escalate_llm werden blockiert.
function effectiveC1(decision) {
  return decision === "allow" ? "allow" : "block";
}
const isIntervention = (eff) => eff === "block";

const results = [];
for (const c of rows) {
  const workdir = c.workdir || WORKSPACE_ROOT;
  let verdict, err = null;
  try {
    verdict = evaluateExecPolicy({ command: c.command, workdir, workspaceRoot: WORKSPACE_ROOT, config: {} });
  } catch (e) {
    err = String(e && e.message ? e.message : e);
    verdict = { decision: "block", ruleId: "internal_error", durationMs: null };
  }
  const observed = verdict.decision;
  const eff = effectiveC1(observed);
  const match = observed === c.expected_decision;
  // Sicherheits-Sicht (config-effektiv C1) gegen binaeres Risiko:
  const benign = c.risk === 0;
  const risky = c.risk === 1;
  const intervened = isIntervention(eff);
  const fp = benign && intervened;      // benigne Aufgabe gestoert
  const fn = risky && eff === "allow";  // riskanter Call durchgelassen (Bypass)
  results.push({
    id: c.id, suite: c.suite, risk_class: c.risk_class,
    bypass_class: c.bypass_class ?? null,
    command: c.command, workdir,
    expected_decision: c.expected_decision, observed_decision: observed,
    decision_match: match,
    effective_c1: eff, risk: c.risk,
    false_positive_c1: fp, false_negative_c1: fn, bypass_c1: fn,
    rule_id: verdict.ruleId ?? null, severity: verdict.severity ?? null,
    duration_ms: verdict.durationMs ?? null,
    target_canonicals: verdict.targetCanonicals ?? null,
    effect: c.effect ?? null, threat: c.threat ?? null,
    note: c.note ?? "", error: err
  });
}

writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join("\n") + "\n");

// ---------- Konsolenzusammenfassung ----------
const n = results.length;
const matches = results.filter((r) => r.decision_match).length;
const benignN = results.filter((r) => r.risk === 0).length;
const riskyN = results.filter((r) => r.risk === 1).length;
const fpN = results.filter((r) => r.false_positive_c1).length;
const fnN = results.filter((r) => r.false_negative_c1).length;

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + "%" : "n/a");

console.log(`\n=== ${inPath.split("/").pop()}  (${n} Faelle) ===`);
console.log(`policy_match_rate (Code vs. Spez.): ${matches}/${n} = ${pct(matches, n)}`);
console.log(`C1-effektiv  FPR (benign gestoert): ${fpN}/${benignN} = ${pct(fpN, benignN)}`);
console.log(`C1-effektiv  FNR/Bypass (riskant durchgelassen): ${fnN}/${riskyN} = ${pct(fnN, riskyN)}`);

// Entscheidungsverteilung
const dist = {};
for (const r of results) dist[r.observed_decision] = (dist[r.observed_decision] || 0) + 1;
console.log("Entscheidungsverteilung (beobachtet):", dist);

// Mismatches (Code != Spez.) -- die wissenschaftlich interessanten Befunde
const mm = results.filter((r) => !r.decision_match);
if (mm.length) {
  console.log(`\n--- Abweichungen Code vs. Spezifikation (${mm.length}) ---`);
  for (const r of mm) {
    console.log(`  ${r.id}  "${r.command}"  spez=${r.expected_decision}  code=${r.observed_decision}  (${r.rule_id})`);
  }
}

// Bypasses (riskant -> allow): sicherheitskritisch
const byp = results.filter((r) => r.bypass_c1);
if (byp.length) {
  console.log(`\n--- BYPASS / False Negatives unter C1 (${byp.length}) ---`);
  for (const r of byp) {
    console.log(`  ${r.id}  "${r.command}"  -> ${r.observed_decision}  [effect=${r.effect}]  ${r.note}`);
  }
} else {
  console.log("\nKeine Bypasses unter C1 (jeder riskante Fall fuehrt zu Eingriff).");
}

// False Positives (benign -> Eingriff)
const fps = results.filter((r) => r.false_positive_c1);
if (fps.length) {
  console.log(`\n--- False Positives unter C1 (${fps.length}, benigne Aufgaben blockiert) ---`);
  for (const r of fps) console.log(`  ${r.id}  "${r.command}"  -> ${r.effective_c1}  [${r.risk_class}]`);
}
