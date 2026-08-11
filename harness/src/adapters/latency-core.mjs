import { performance } from "node:perf_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadPolicyCorpus } from "../lib/corpus.mjs";
import { atomicWriteJson } from "../lib/json.mjs";
import { DEFAULT_WORKSPACE_ROOT } from "./policy-offline.mjs";

function positiveInteger(value, label, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} muss eine ${allowZero ? "nichtnegative" : "positive"} Ganzzahl sein`);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function summarizeDurations(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Latenzwerte müssen endlich und nichtleer sein");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rounded = (value) => +value.toFixed(4);
  return {
    n: sorted.length,
    mean_ms: rounded(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50_ms: rounded(percentile(sorted, 50)),
    p95_ms: rounded(percentile(sorted, 95)),
    p99_ms: rounded(percentile(sorted, 99)),
    max_ms: rounded(sorted.at(-1)),
    min_ms: rounded(sorted[0]),
  };
}

export async function measurePolicyLatency({
  corpusPath,
  policySource,
  outputPath,
  iterations,
  warmupCalls = 5000,
  expectedCases = null,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
  config = {},
  round = 1,
}) {
  positiveInteger(iterations, "iterations");
  positiveInteger(warmupCalls, "warmupCalls", { allowZero: true });
  const corpus = await loadPolicyCorpus(corpusPath, { expectedCases });
  const { evaluateExecPolicy } = await import(pathToFileURL(path.resolve(policySource)).href);
  if (typeof evaluateExecPolicy !== "function") throw new Error(`evaluateExecPolicy fehlt in ${policySource}`);

  for (let index = 0; index < warmupCalls; index += 1) {
    const row = corpus.cases[index % corpus.cases.length];
    evaluateExecPolicy({
      command: row.command,
      workdir: row.workdir || workspaceRoot,
      workspaceRoot,
      config,
    });
  }

  const perCommand = [];
  const byClass = new Map();
  const allSelf = [];
  const allWall = [];
  for (const row of corpus.cases) {
    const self = [];
    const wall = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const startedAt = performance.now();
      const verdict = evaluateExecPolicy({
        command: row.command,
        workdir: row.workdir || workspaceRoot,
        workspaceRoot,
        config,
      });
      const finishedAt = performance.now();
      if (!Number.isFinite(verdict.durationMs)) throw new Error(`Fall ${row.id}: durationMs fehlt`);
      self.push(verdict.durationMs);
      wall.push(finishedAt - startedAt);
    }
    perCommand.push({
      id: row.id,
      risk_class: row.risk_class,
      command: row.command,
      self: summarizeDurations(self),
      wall: summarizeDurations(wall),
    });
    if (!byClass.has(row.risk_class)) byClass.set(row.risk_class, []);
    byClass.get(row.risk_class).push(...self);
    allSelf.push(...self);
    allWall.push(...wall);
  }

  const byClassSelf = Object.fromEntries([...byClass.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([riskClass, values]) => [riskClass, summarizeDurations(values)]));
  const output = {
    schemaVersion: 1,
    meta: {
      round,
      iterations_per_command: iterations,
      commands: corpus.cases.length,
      total_evaluations: corpus.cases.length * iterations,
      warmup_calls: warmupCalls,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      fresh_process: true,
      note: "self = policy-interne durationMs; wall = Wall-Clock pro Aufruf",
    },
    corpus: { sha256: corpus.sha256 },
    overall_self: summarizeDurations(allSelf),
    overall_wall: summarizeDurations(allWall),
    by_class_self: byClassSelf,
    per_command: perCommand,
  };
  await atomicWriteJson(outputPath, output);
  return output;
}
