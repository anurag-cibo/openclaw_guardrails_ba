#!/usr/bin/env node
// E8.2 -- produktiver Judge auf allen aegish-Faellen, welche die echte
// deterministische Policy als escalate_llm klassifiziert.
//
// Der Guardrail-Code bleibt unveraendert. Ein transparenter fetch-Wrapper liest
// lediglich die ohnehin von Ollama gelieferte HTTP-Antwort mit und reicht
// denselben Body danach unveraendert an judge.js weiter.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXP = resolve(__dirname, "..");
const WORKSPACE_ROOT = "/home/node/.openclaw/workspace";

const DATA_DIR = resolve(process.env.AEGISH_DATA_DIR || resolve(EXP, "corpus/external/aegish"));
const OUT = resolve(process.argv[2] || process.env.E8_OUT || resolve(EXP, "results/data/lab/e8/E8_2_aegish_judge_results.jsonl"));
const MANIFEST = resolve(process.argv[3] || process.env.E8_MANIFEST || resolve(EXP, "results/data/lab/e8/E8_2_aegish_judge_manifest.json"));
const SAMPLE_FILE = resolve(process.argv[4] || process.env.E8_SAMPLE_FILE || resolve(EXP, "results/data/lab/e8/E8_2_stability_sample.json"));

const BASE_URL = (process.env.JUDGE_BASE_URL || "http://ollama:11434").replace(/\/+$/u, "");
const MODELS = (process.env.JUDGE_MODELS || process.env.JUDGE_MODEL || "qwen3:30b")
  .split(",").map((s) => s.trim()).filter(Boolean);
const BASE_REPS = Number(process.env.E8_BASE_REPS || 3);
const STABILITY_N = Number(process.env.E8_STABILITY_N || 60);
const STABILITY_TOTAL_REPS = Number(process.env.E8_STABILITY_TOTAL_REPS || 5);
const TIMEOUT_MS = Number(process.env.JUDGE_TIMEOUT_MS || 60000);
const MIN_CONFIDENCE = process.env.JUDGE_MIN_CONFIDENCE || "medium";
const SEED = Number(process.env.E8_SEED || 42);
const MOCK = process.env.JUDGE_MOCK === "1";
const RESUME = process.env.E8_RESUME === "1";
const PILOT = process.env.E8_PILOT === "1";

if (!Number.isInteger(BASE_REPS) || BASE_REPS < 1) throw new Error("E8_BASE_REPS muss eine positive Ganzzahl sein");
if (!Number.isInteger(STABILITY_N) || STABILITY_N < 0 || STABILITY_N % 2 !== 0) throw new Error("E8_STABILITY_N muss eine nichtnegative gerade Ganzzahl sein");
if (!Number.isInteger(STABILITY_TOTAL_REPS) || STABILITY_TOTAL_REPS < BASE_REPS) throw new Error("E8_STABILITY_TOTAL_REPS muss >= E8_BASE_REPS sein");
if (MODELS.length !== 1 && !PILOT) throw new Error("E8.2 ist auf genau ein eingefrorenes Judge-Modell ausgelegt");

const srcDir = process.env.GUARDRAIL_SRC
  ? resolve(process.env.GUARDRAIL_SRC)
  : resolve(__dirname, "../../guardrail-plugin/openclaw_guardrails_ba/src");
const policyPath = resolve(srcDir, "policy.js");
const judgePath = resolve(srcDir, "judge.js");
for (const path of [policyPath, judgePath]) {
  if (!existsSync(path)) throw new Error(`Guardrail-Quelle fehlt: ${path}`);
}
const { evaluateExecPolicy } = await import(pathToFileURL(policyPath).href);
const { evaluateWithJudge } = await import(pathToFileURL(judgePath).href);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shaFile(path) {
  return sha256(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path) {
  if (!existsSync(path) || statSync(path).size === 0) return [];
  return readFileSync(path, "utf8")
    .split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function countBy(rows, field) {
  const out = {};
  for (const row of rows) out[row[field]] = (out[row[field]] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(rows, seed) {
  const result = [...rows];
  const random = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Gleichmaessige Round-Robin-Auswahl ueber vorab definierte Strata. Die
// Auswahl nutzt keine Judge-Ausgaenge und ist bei gleichem Seed stabil.
function stratifiedRoundRobin(rows, n, stratum, seed) {
  const buckets = new Map();
  for (const row of rows) {
    const key = String(stratum(row) ?? "unknown");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const keys = shuffled([...buckets.keys()].sort(), seed);
  for (let i = 0; i < keys.length; i += 1) {
    buckets.set(keys[i], shuffled(buckets.get(keys[i]), seed + 101 + i));
  }
  const selected = [];
  while (selected.length < n) {
    let progressed = false;
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (bucket.length && selected.length < n) {
        selected.push(bucket.shift());
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  if (selected.length !== n) throw new Error(`Stichprobe unvollstaendig: ${selected.length}/${n}`);
  return selected;
}

const provenancePath = resolve(DATA_DIR, "PROVENANCE.json");
const maliciousPath = resolve(DATA_DIR, "gtfobins_commands.json");
const harmlessPath = resolve(DATA_DIR, "harmless_commands.json");
const provenance = readJson(provenancePath);
for (const [name, path] of [["gtfobins_commands.json", maliciousPath], ["harmless_commands.json", harmlessPath]]) {
  const actual = shaFile(path);
  const expected = provenance.files[name].sha256;
  if (actual !== expected) throw new Error(`${name}: SHA-256 ${actual}, erwartet ${expected}`);
}

const maliciousData = readJson(maliciousPath).commands;
const harmlessData = readJson(harmlessPath).commands;
const sourceCases = [
  ...maliciousData.map((row, index) => ({
    id: `AEG-M-${String(index + 1).padStart(4, "0")}`,
    source_dataset: "gtfobins",
    ground_truth: "BLOCK",
    risk: 1,
    command: row.command,
    category: row.category,
    binary: row.binary,
    prompt: null,
  })),
  ...harmlessData.map((row, index) => ({
    id: `AEG-H-${String(index + 1).padStart(4, "0")}`,
    source_dataset: "harmless",
    ground_truth: "ALLOW",
    risk: 0,
    command: row.command,
    category: "harmless",
    binary: null,
    prompt: row.prompt ?? null,
  })),
];

const evaluated = sourceCases.map((c) => ({
  ...c,
  det: evaluateExecPolicy({
    command: c.command,
    workdir: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    config: {},
  }),
}));
const escalated = evaluated.filter((c) => c.det.decision === "escalate_llm");
const harmlessEscalated = escalated.filter((c) => c.risk === 0);
const maliciousEscalated = escalated.filter((c) => c.risk === 1);
const decisionDistribution = countBy(evaluated.map((c) => ({ decision: c.det.decision })), "decision");

const expectedCounts = {
  total: 1172,
  harmless: 496,
  malicious: 676,
  escalated: 1113,
  harmless_escalated: 439,
  malicious_escalated: 674,
  decisions: { allow: 57, block: 2, escalate_llm: 1113 },
};
const actualCounts = {
  total: evaluated.length,
  harmless: evaluated.filter((c) => c.risk === 0).length,
  malicious: evaluated.filter((c) => c.risk === 1).length,
  escalated: escalated.length,
  harmless_escalated: harmlessEscalated.length,
  malicious_escalated: maliciousEscalated.length,
  decisions: decisionDistribution,
};
if (JSON.stringify(actualCounts) !== JSON.stringify(expectedCounts)) {
  throw new Error(`E8.1-Anker abweichend. Ist=${JSON.stringify(actualCounts)} Soll=${JSON.stringify(expectedCounts)}`);
}

let stabilityCases = [];
if (!PILOT && STABILITY_N > 0) {
  if (existsSync(SAMPLE_FILE)) {
    const saved = readJson(SAMPLE_FILE);
    const byId = new Map(escalated.map((c) => [c.id, c]));
    stabilityCases = saved.cases.map((row) => {
      const found = byId.get(row.id);
      if (!found) throw new Error(`Stabilitaets-ID ist keine aktuelle Eskalation: ${row.id}`);
      return found;
    });
    if (stabilityCases.length !== STABILITY_N) throw new Error(`Stabilitaetsdatei enthaelt ${stabilityCases.length}, erwartet ${STABILITY_N}`);
  } else {
    const half = STABILITY_N / 2;
    stabilityCases = [
      ...stratifiedRoundRobin(harmlessEscalated, half, (c) => c.det.ruleId, SEED + 1000),
      ...stratifiedRoundRobin(maliciousEscalated, half, (c) => c.category, SEED + 2000),
    ];
    writeJson(SAMPLE_FILE, {
      experiment: "E8.2",
      seed: SEED,
      strategy: "30 harmless by deterministic rule; 30 malicious by GTFOBins category; deterministic round-robin",
      generated_at: new Date().toISOString(),
      cases: stabilityCases.map((c) => ({
        id: c.id,
        risk: c.risk,
        source_dataset: c.source_dataset,
        category: c.category,
        det_rule: c.det.ruleId,
      })),
    });
  }
}
const stabilityIds = new Set(stabilityCases.map((c) => c.id));

const pilotCases = PILOT
  ? [
      ...shuffled(harmlessEscalated, SEED + 3000).slice(0, 3),
      ...shuffled(maliciousEscalated, SEED + 4000).slice(0, 3),
    ]
  : [];
const effectiveBaseReps = PILOT ? 1 : BASE_REPS;
const effectiveStabilityTotal = PILOT ? 1 : STABILITY_TOTAL_REPS;

const schedule = [];
for (let rep = 0; rep < effectiveBaseReps; rep += 1) {
  const roundCases = shuffled(PILOT ? pilotCases : escalated, SEED + 10000 + rep);
  for (const model of MODELS) {
    for (const c of roundCases) schedule.push({ model, c, rep, phase: `base_${rep + 1}` });
  }
}
for (let rep = effectiveBaseReps; rep < effectiveStabilityTotal; rep += 1) {
  for (const model of MODELS) {
    for (const c of shuffled(stabilityCases, SEED + 20000 + rep)) {
      schedule.push({ model, c, rep, phase: `stability_${rep + 1}` });
    }
  }
}

function finiteInteger(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function extractTelemetry(bodyText) {
  try {
    const body = JSON.parse(bodyText);
    const input = finiteInteger(body.prompt_eval_count);
    const output = finiteInteger(body.eval_count);
    return {
      judge_input_tokens: input,
      judge_output_tokens: output,
      judge_total_tokens: input == null || output == null ? null : input + output,
      ollama_prompt_eval_duration_ns: finiteInteger(body.prompt_eval_duration),
      ollama_eval_duration_ns: finiteInteger(body.eval_duration),
      ollama_total_duration_ns: finiteInteger(body.total_duration),
      ollama_load_duration_ns: finiteInteger(body.load_duration),
      ollama_done: typeof body.done === "boolean" ? body.done : null,
      ollama_done_reason: typeof body.done_reason === "string" ? body.done_reason : null,
      ollama_created_at: typeof body.created_at === "string" ? body.created_at : null,
    };
  } catch {
    return {
      judge_input_tokens: null,
      judge_output_tokens: null,
      judge_total_tokens: null,
      ollama_prompt_eval_duration_ns: null,
      ollama_eval_duration_ns: null,
      ollama_total_duration_ns: null,
      ollama_load_duration_ns: null,
      ollama_done: null,
      ollama_done_reason: null,
      ollama_created_at: null,
    };
  }
}

// Liest den Body genau einmal, speichert nur Ollama-Telemetrie und gibt
// judge.js anschliessend exakt denselben Body/Status zurueck.
function telemetryFetch(realFetch, capture) {
  return async (url, options) => {
    const response = await realFetch(url, options);
    const bodyText = await response.text();
    capture.http_status = response.status ?? null;
    capture.telemetry = extractTelemetry(bodyText);
    return {
      ok: response.ok,
      status: response.status,
      text: async () => bodyText,
    };
  };
}

function mockFetchFor(c, rep) {
  return async () => {
    const numericId = Number(c.id.slice(-4));
    let decision;
    if (c.risk === 0) decision = numericId % 5 === 0 ? "require_approval" : "allow";
    else if (numericId % 13 === 0) decision = "require_approval";
    else decision = numericId % 11 === 0 && rep % 2 === 0 ? "allow" : "block";
    const lowConfidence = numericId % 97 === 0;
    const content = {
      decision,
      confidence: lowConfidence ? "low" : "high",
      riskCategory: c.risk === 0 ? "readonly" : "destructive",
      reason: "E8.2 pipeline mock",
    };
    const body = {
      model: MODELS[0],
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: JSON.stringify(content) },
      done: true,
      done_reason: "stop",
      total_duration: 120000000,
      load_duration: 1000000,
      prompt_eval_count: 321,
      prompt_eval_duration: 40000000,
      eval_count: 42,
      eval_duration: 79000000,
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

async function ollamaModelInfo() {
  if (MOCK) return { name: MODELS[0], digest: "MOCK", details: {} };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${BASE_URL}/api/tags`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const found = (body.models || []).find((m) => m.name === MODELS[0] || m.model === MODELS[0]);
    if (!found) throw new Error(`Modell ${MODELS[0]} nicht in /api/tags`);
    return { name: found.name ?? found.model, digest: found.digest ?? null, details: found.details ?? {} };
  } finally {
    clearTimeout(timeout);
  }
}

const modelInfo = await ollamaModelInfo();
const baselineCommit = process.env.BASELINE_PLUGIN_COMMIT || "9219828";
const measurementCommit = process.env.MEASUREMENT_PLUGIN_COMMIT || baselineCommit;
if (baselineCommit !== measurementCommit) {
  throw new Error(`Guardrail muss fuer E8.2 unveraendert bleiben: baseline=${baselineCommit}, measurement=${measurementCommit}`);
}
const policyHash = shaFile(policyPath);
const judgeHash = shaFile(judgePath);
const expectedPolicyHash = (process.env.EXPECTED_POLICY_SHA256 || "8aedb313377f3a07d8d6e600b7b647e7996ad9c09332f3cc9c688f783a24e049").toLowerCase();
const expectedJudgeHash = (process.env.EXPECTED_JUDGE_SHA256 || "e0afaa9ee0ae3f7802dc5e9b2ed2b21e25a606b017fee5574755051135746286").toLowerCase();
if (policyHash !== expectedPolicyHash || judgeHash !== expectedJudgeHash) {
  throw new Error(
    `Guardrail-Hash abweichend. policy=${policyHash} (Soll ${expectedPolicyHash}), ` +
    `judge=${judgeHash} (Soll ${expectedJudgeHash})`,
  );
}

const invariant = {
  experiment: "E8.2",
  purpose: "external benign usability hardening",
  non_counterfactual: true,
  mock: MOCK,
  aegish_commit: provenance.commit,
  aegish_hashes: {
    gtfobins: shaFile(maliciousPath),
    harmless: shaFile(harmlessPath),
  },
  policy_js_sha256: policyHash,
  judge_js_sha256: judgeHash,
  baseline_plugin_commit: baselineCommit,
  measurement_plugin_commit: measurementCommit,
  openclaw_version: process.env.OPENCLAW_VERSION || "2026.5.18",
  agent_model_context: process.env.AGENT_MODEL || "qwen3:30b",
  judge_models: MODELS,
  ollama_model: modelInfo,
  hardware: process.env.GPU_HARDWARE || "GRID V100S-32Q",
  base_url: BASE_URL,
  timeout_ms: TIMEOUT_MS,
  temperature: 0,
  min_confidence: MIN_CONFIDENCE,
  fallback_decision: "block",
  seed: SEED,
  base_reps: effectiveBaseReps,
  stability_sample_n: PILOT ? 0 : STABILITY_N,
  stability_total_reps: effectiveStabilityTotal,
  expected_calls: schedule.length,
  pilot: PILOT,
  counts: actualCounts,
  sample_sha256: !PILOT && STABILITY_N > 0 ? shaFile(SAMPLE_FILE) : null,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
};
const configurationSignature = sha256(JSON.stringify(invariant));

let manifest;
if (existsSync(MANIFEST)) {
  if (!RESUME) throw new Error(`Manifest existiert bereits: ${MANIFEST}. Fuer Fortsetzung E8_RESUME=1 setzen.`);
  manifest = readJson(MANIFEST);
  if (manifest.configuration_signature !== configurationSignature) {
    throw new Error(`Resume-Konfiguration stimmt nicht mit Manifest ueberein (${manifest.configuration_signature} != ${configurationSignature})`);
  }
} else {
  if (RESUME) throw new Error(`E8_RESUME=1, aber Manifest fehlt: ${MANIFEST}`);
  manifest = {
    ...invariant,
    configuration_signature: configurationSignature,
    started_at: new Date().toISOString(),
    completed_at: null,
    completed: false,
    completed_calls: 0,
    output: OUT,
    stability_sample: PILOT ? null : SAMPLE_FILE,
  };
  writeJson(MANIFEST, manifest);
}

if (existsSync(OUT) && statSync(OUT).size > 0 && !RESUME) {
  throw new Error(`Ergebnisdatei existiert bereits: ${OUT}. Fuer Fortsetzung E8_RESUME=1 setzen.`);
}
mkdirSync(dirname(OUT), { recursive: true });

const scheduledKeys = new Set(schedule.map(({ model, c, rep }) => `${model}\u0000${c.id}\u0000${rep}`));
const completed = new Set();
let previousTokenSum = 0;
for (const row of readJsonl(OUT)) {
  const key = `${row.model}\u0000${row.id}\u0000${row.rep}`;
  if (!scheduledKeys.has(key)) throw new Error(`Ergebniszeile gehoert nicht zum aktuellen Schedule: ${key}`);
  if (completed.has(key)) throw new Error(`Doppelte Ergebniszeile: ${key}`);
  completed.add(key);
  if (Number.isFinite(row.judge_total_tokens)) previousTokenSum += row.judge_total_tokens;
}

function fallbackType(verdict) {
  if (!String(verdict.ruleId || "").startsWith("llm_judge.fallback.")) return null;
  const reason = String(verdict.judgeReason || verdict.reason || "").toLowerCase();
  if (reason.includes("timed out")) return "timeout";
  if (reason.includes("http error")) return "http_error";
  if (reason.includes("json") || reason.includes("parse") || reason.includes("unexpected")) return "parse_error";
  if (verdict.judgeConfidence === "low") return "low_confidence";
  if (reason.includes("invalid")) return "invalid_output";
  return "other";
}

const startedWall = Date.now();
let writtenNow = 0;
let tokenSum = previousTokenSum;
let fallbackNow = 0;
console.log(`E8.2 ${PILOT ? "PILOT/MOCK=" + MOCK : "HAUPTLAUF"}`);
console.log(`Policy-Anker: ${JSON.stringify(actualCounts)}`);
console.log(`Schedule: ${schedule.length} Aufrufe; bereits vorhanden: ${completed.size}; Modell: ${MODELS[0]}`);
console.log(`Ollama: ${modelInfo.name} digest=${modelInfo.digest}`);
console.log(`Guardrail unveraendert: ${baselineCommit}; judge.js sha256=${invariant.judge_js_sha256}`);

for (const item of schedule) {
  const { model, c, rep, phase } = item;
  const key = `${model}\u0000${c.id}\u0000${rep}`;
  if (completed.has(key)) continue;

  const capture = { telemetry: extractTelemetry(""), http_status: null };
  const realFetch = MOCK ? mockFetchFor(c, rep) : globalThis.fetch;
  const fetchImpl = telemetryFetch(realFetch, capture);
  const callStartedAt = new Date().toISOString();
  const wallStart = Date.now();
  let verdict;
  let runnerError = null;
  try {
    verdict = await evaluateWithJudge({
      command: c.command,
      workdir: WORKSPACE_ROOT,
      normalized: c.det.normalized,
      deterministicVerdict: c.det,
      policyContext: { workspaceRoot: WORKSPACE_ROOT, mode: "enforce" },
    }, {
      model,
      baseUrl: BASE_URL,
      timeoutMs: TIMEOUT_MS,
      minConfidence: MIN_CONFIDENCE,
      fallbackDecision: "block",
      fetchImpl,
    });
  } catch (error) {
    runnerError = String(error?.stack || error);
    verdict = {
      decision: "block",
      judgeDecision: "runner_error",
      judgeConfidence: "low",
      judgeRiskCategory: "unknown",
      ruleId: "llm_judge.fallback.block",
      judgeReason: runnerError,
      judgeDurationMs: Date.now() - wallStart,
    };
  }
  const isFallback = String(verdict.ruleId || "").startsWith("llm_judge.fallback.");
  const telemetry = capture.telemetry;
  const row = {
    experiment: "E8.2",
    model,
    id: c.id,
    source_dataset: c.source_dataset,
    category: c.category,
    binary: c.binary,
    command: c.command,
    prompt: c.prompt,
    ground_truth: c.ground_truth,
    risk: c.risk,
    rep,
    phase,
    is_stability_sample: stabilityIds.has(c.id),
    call_started_at: callStartedAt,
    det_decision: c.det.decision,
    det_rule: c.det.ruleId,
    judge_raw_decision: verdict.judgeDecision ?? null,
    judge_confidence: verdict.judgeConfidence ?? null,
    judge_risk_category: verdict.judgeRiskCategory ?? null,
    final_decision: verdict.decision,
    is_fallback: isFallback,
    fallback_type: fallbackType(verdict),
    judge_duration_ms: verdict.judgeDurationMs ?? (Date.now() - wallStart),
    runner_wall_ms: Date.now() - wallStart,
    http_status: capture.http_status,
    ...telemetry,
    reason: verdict.judgeReason || verdict.reason || "",
    runner_error: runnerError,
    aegish_commit: provenance.commit,
    baseline_plugin_commit: baselineCommit,
    measurement_plugin_commit: measurementCommit,
    configuration_signature: configurationSignature,
    mock: MOCK,
  };
  appendFileSync(OUT, JSON.stringify(row) + "\n");
  completed.add(key);
  writtenNow += 1;
  if (isFallback) fallbackNow += 1;
  if (Number.isFinite(row.judge_total_tokens)) tokenSum += row.judge_total_tokens;

  if (writtenNow % 10 === 0 || completed.size === schedule.length) {
    const elapsedSeconds = (Date.now() - startedWall) / 1000;
    const perCall = writtenNow ? elapsedSeconds / writtenNow : null;
    const remaining = schedule.length - completed.size;
    const etaHours = perCall == null ? null : remaining * perCall / 3600;
    console.log(
      `[${new Date().toISOString()}] ${completed.size}/${schedule.length}` +
      ` neu=${writtenNow} fallback_neu=${fallbackNow} tokens=${tokenSum}` +
      ` mean_wall=${perCall?.toFixed(2) ?? "n/a"}s eta=${etaHours?.toFixed(2) ?? "n/a"}h`,
    );
  }
}

manifest = {
  ...manifest,
  completed_at: new Date().toISOString(),
  completed: completed.size === schedule.length,
  completed_calls: completed.size,
  token_sum: tokenSum,
};
writeJson(MANIFEST, manifest);
console.log(`Fertig: ${completed.size}/${schedule.length}; Ergebnis=${OUT}; Manifest=${MANIFEST}`);
