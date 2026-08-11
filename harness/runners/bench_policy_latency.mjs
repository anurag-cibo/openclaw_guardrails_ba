#!/usr/bin/env node
// bench_policy_latency.mjs -- E3: Mikrobenchmark des deterministischen Layers.
// Misst guardrail_duration_ms pro Aufruf (policy-eigene Messung) ueber viele
// Wiederholungen und berechnet Perzentile, gesamt und pro Risikoklasse.
//
// Nutzung:
//   node bench_policy_latency.mjs [iterationen=2000] [korpus.jsonl] [out.json]
//
// Der Offline-Benchmark misst verdict.durationMs direkt am Rueckgabewert. Das
// Runtime-Log fuehrt dieselbe Schicht separat als deterministicDurationMs.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = "/home/node/.openclaw/workspace";

const ITER = Number(process.argv[2] || 2000);
const inPath = process.argv[3] || resolve(__dirname, "../corpus/policy_corpus.jsonl");
const outPath = process.argv[4] || resolve(__dirname, "../results/data/lab/e3/E3_latency.json");

const srcDir = process.env.GUARDRAIL_SRC
  ? resolve(process.env.GUARDRAIL_SRC)
  : resolve(__dirname, "../../guardrail-plugin/openclaw_guardrails_ba/src");
if (!existsSync(resolve(srcDir, "policy.js"))) {
  console.error(`policy.js nicht gefunden unter ${srcDir}. GUARDRAIL_SRC setzen.`);
  process.exit(2);
}
const { evaluateExecPolicy } = await import(pathToFileURL(resolve(srcDir, "policy.js")).href);

const rows = readFileSync(inPath, "utf8")
  .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
function summarize(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    mean_ms: +(sum / s.length).toFixed(4),
    p50_ms: +percentile(s, 50).toFixed(4),
    p95_ms: +percentile(s, 95).toFixed(4),
    p99_ms: +percentile(s, 99).toFixed(4),
    max_ms: +s[s.length - 1].toFixed(4),
    min_ms: +s[0].toFixed(4)
  };
}

// Warmup (JIT)
for (let i = 0; i < 5000; i++) {
  const c = rows[i % rows.length];
  evaluateExecPolicy({ command: c.command, workdir: c.workdir || WORKSPACE_ROOT, workspaceRoot: WORKSPACE_ROOT, config: {} });
}

const perCommand = [];
const byClass = {};
const allSelf = [];
const allWall = [];

for (const c of rows) {
  const workdir = c.workdir || WORKSPACE_ROOT;
  const self = [];
  const wall = [];
  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now();
    const v = evaluateExecPolicy({ command: c.command, workdir, workspaceRoot: WORKSPACE_ROOT, config: {} });
    const t1 = performance.now();
    self.push(v.durationMs);     // policy-interne Messung
    wall.push((t1 - t0));        // Wall-Clock inkl. Aufrufoverhead
  }
  const sSelf = summarize(self);
  perCommand.push({ id: c.id, risk_class: c.risk_class, command: c.command, self: sSelf, wall: summarize(wall) });
  (byClass[c.risk_class] ||= []).push(...self);
  allSelf.push(...self);
  allWall.push(...wall);
}

const classSummary = {};
for (const [k, v] of Object.entries(byClass)) classSummary[k] = summarize(v);

const out = {
  meta: {
    iterations_per_command: ITER,
    commands: rows.length,
    total_evaluations: rows.length * ITER,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    note: "self = policy-interne durationMs (verdict.durationMs); wall = Wall-Clock pro Aufruf"
  },
  overall_self: summarize(allSelf),
  overall_wall: summarize(allWall),
  by_class_self: classSummary,
  per_command: perCommand
};
writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`E3 Latenz-Mikrobenchmark (${rows.length} Kommandos x ${ITER} Iter = ${rows.length * ITER} Auswertungen)`);
console.log("\nGesamt (policy-interne durationMs):", out.overall_self);
console.log("Gesamt (Wall-Clock pro Aufruf):    ", out.overall_wall);
console.log("\nPer Risikoklasse (durationMs):");
for (const [k, v] of Object.entries(classSummary).sort()) {
  console.log(`  ${k.padEnd(22)} mean=${v.mean_ms.toFixed(4)}ms  p95=${v.p95_ms.toFixed(4)}ms  p99=${v.p99_ms.toFixed(4)}ms`);
}
console.log(`\ngeschrieben: ${outPath}`);
