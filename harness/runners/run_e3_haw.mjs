#!/usr/bin/env node
// E3-HAW: Zielsystem-Replikation des bestehenden Policy-Mikrobenchmarks.
//
// Dieser Runner aendert oder kopiert den Guardrail nicht. Er prueft die
// eingefrorenen Hashes von policy.js, judge.js und index.js und startet fuer
// jede Runde einen frischen Node-Prozess mit bench_policy_latency.mjs. Dadurch
// besitzt jede Runde einen eigenen JIT-Warm-up und einen eigenen Prozesszustand.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXP = resolve(__dirname, "..");

function envInt(name, fallback, minimum = 1) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} muss eine ganze Zahl >= ${minimum} sein`);
  }
  return value;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${name} muss 0/1 oder false/true sein`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Object(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function assertHash(label, path, expected) {
  if (!existsSync(path)) throw new Error(`${label} fehlt: ${path}`);
  const observed = sha256File(path);
  if (expected && observed !== expected.toLowerCase()) {
    throw new Error(`${label}-Hash abweichend: erwartet ${expected}, beobachtet ${observed}`);
  }
  return observed;
}

const rounds = envInt("E3_ROUNDS", 5);
const iterations = envInt("E3_ITERATIONS", 3000);
const resume = envBool("E3_RESUME", false);
const pilot = envBool("E3_PILOT", false);
const expectedPlatform = process.env.E3_EXPECT_PLATFORM || "linux";
const expectedArch = process.env.E3_EXPECT_ARCH || "x64";
const workspaceRoot = process.env.E3_WORKSPACE_ROOT || "/home/node/.openclaw/workspace";

const outputDir = resolve(process.env.E3_OUT_DIR || resolve(EXP, "results/data/lab/e3/haw"));
const manifestPath = resolve(process.env.E3_MANIFEST || resolve(outputDir, "E3_haw_manifest.json"));
const corpusPath = resolve(process.env.E3_CORPUS || resolve(EXP, "corpus/policy_corpus.jsonl"));
const benchmarkPath = resolve(process.env.E3_BENCHMARK || resolve(__dirname, "bench_policy_latency.mjs"));
const guardrailSrc = resolve(
  process.env.GUARDRAIL_SRC || resolve(EXP, "../guardrail-plugin/openclaw_guardrails_ba/src"),
);

const policyPath = resolve(guardrailSrc, "policy.js");
const judgePath = resolve(guardrailSrc, "judge.js");
const indexPath = resolve(guardrailSrc, "index.js");

const expectedHashes = {
  policy_js: (process.env.EXPECTED_POLICY_SHA256 || "8aedb313377f3a07d8d6e600b7b647e7996ad9c09332f3cc9c688f783a24e049").toLowerCase(),
  judge_js: (process.env.EXPECTED_JUDGE_SHA256 || "e0afaa9ee0ae3f7802dc5e9b2ed2b21e25a606b017fee5574755051135746286").toLowerCase(),
  index_js: (process.env.EXPECTED_INDEX_SHA256 || "ad4f7b1dcdb99a7bfd5b68fddf5b03e12bcbc42e42f98a07901bf871fc9292e0").toLowerCase(),
  corpus: (process.env.EXPECTED_CORPUS_SHA256 || "76774d8a80c583a8116ec9c4831c0ecbd93f306c92837827eeae2a0380bb1ffb").toLowerCase(),
  benchmark: (process.env.EXPECTED_BENCHMARK_SHA256 || "99bcc72f7b62f0c9d17e0407d13936b4941c94513e904887235531034e4c07df").toLowerCase(),
};

const baselineCommit = process.env.BASELINE_PLUGIN_COMMIT || "9219828";
const measurementCommit = process.env.MEASUREMENT_PLUGIN_COMMIT || baselineCommit;
if (measurementCommit !== baselineCommit) {
  throw new Error(`Guardrail-Commit abweichend: baseline=${baselineCommit}, measurement=${measurementCommit}`);
}
if (process.platform !== expectedPlatform || process.arch !== expectedArch) {
  throw new Error(
    `falsche Laufplattform: erwartet ${expectedPlatform}/${expectedArch}, ` +
    `beobachtet ${process.platform}/${process.arch}`,
  );
}

const hashes = {
  policy_js: assertHash("policy.js", policyPath, expectedHashes.policy_js),
  judge_js: assertHash("judge.js", judgePath, expectedHashes.judge_js),
  index_js: assertHash("index.js", indexPath, expectedHashes.index_js),
  corpus: assertHash("policy_corpus.jsonl", corpusPath, expectedHashes.corpus),
  benchmark: assertHash("bench_policy_latency.mjs", benchmarkPath, expectedHashes.benchmark),
};

const corpusRows = readFileSync(corpusPath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
if (corpusRows.length !== 116) {
  throw new Error(`Policy-Korpus muss 116 Zeilen enthalten, beobachtet ${corpusRows.length}`);
}
for (const [index, line] of corpusRows.entries()) {
  try {
    JSON.parse(line);
  } catch (error) {
    throw new Error(`ungueltiges JSONL in Korpuszeile ${index + 1}: ${error.message}`);
  }
}

mkdirSync(outputDir, { recursive: true });
const signatureInput = {
  experiment: "E3",
  variant: "haw_target_replication",
  rounds,
  iterations_per_command: iterations,
  commands: corpusRows.length,
  workspace_root: workspaceRoot,
  policy_config: {},
  baseline_plugin_commit: baselineCommit,
  measurement_plugin_commit: measurementCommit,
  measurement_plugin_commit_full: process.env.PLUGIN_COMMIT_FULL || null,
  expected_platform: expectedPlatform,
  expected_arch: expectedArch,
  hashes,
};
const configurationSignature = sha256Object(signatureInput);

let manifest;
if (existsSync(manifestPath)) {
  if (!resume) {
    throw new Error(`Manifest existiert bereits; E3_RESUME=1 verwenden: ${manifestPath}`);
  }
  manifest = readJson(manifestPath);
  if (manifest.configuration_signature !== configurationSignature) {
    throw new Error("Resume abgelehnt: Konfigurationssignatur stimmt nicht ueberein");
  }
} else {
  const existingRounds = Array.from({ length: rounds }, (_, index) =>
    resolve(outputDir, `E3_haw_round_${String(index + 1).padStart(2, "0")}.json`),
  ).filter(existsSync);
  if (existingRounds.length && !resume) {
    throw new Error(`Rundendateien existieren ohne Manifest: ${existingRounds.join(", ")}`);
  }
  manifest = {
    experiment: "E3",
    title: "Policy-Latenz auf dem HAW-Zielsystem",
    variant: "haw_target_replication",
    pilot,
    guardrail_unchanged: true,
    policy_config: {},
    workspace_root: workspaceRoot,
    baseline_plugin_commit: baselineCommit,
    measurement_plugin_commit: measurementCommit,
    measurement_plugin_commit_full: process.env.PLUGIN_COMMIT_FULL || null,
    hashes,
    schedule: {
      rounds,
      iterations_per_command: iterations,
      commands: corpusRows.length,
      evaluations_per_round: corpusRows.length * iterations,
      total_evaluations: corpusRows.length * iterations * rounds,
      warmup_calls_per_round: 5000,
      fresh_node_process_per_round: true,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      kernel_release: os.release(),
      container_hostname: os.hostname(),
      cpu_model: os.cpus()[0]?.model || null,
      logical_cpus_visible: os.cpus().length,
      total_memory_bytes_visible: os.totalmem(),
      loadavg_at_start: os.loadavg(),
      cgroup_cpu_max: safeRead("/sys/fs/cgroup/cpu.max"),
      cgroup_cpuset_effective: safeRead("/sys/fs/cgroup/cpuset.cpus.effective"),
      gateway_image: process.env.GATEWAY_IMAGE || null,
      gateway_image_id: process.env.GATEWAY_IMAGE_ID || null,
      openclaw_version_context: process.env.OPENCLAW_VERSION || "2026.5.18",
      host_hardware_context: process.env.HOST_HARDWARE || "HAW-Uni-Host / GRID V100S-32Q",
    },
    paths: {
      output_dir: outputDir,
      manifest: manifestPath,
      corpus: corpusPath,
      benchmark: benchmarkPath,
      guardrail_src: guardrailSrc,
    },
    configuration_signature: configurationSignature,
    started_at: new Date().toISOString(),
    completed_at: null,
    completed: false,
    completed_rounds: 0,
    rounds: [],
  };
  atomicJson(manifestPath, manifest);
}

function validateRound(path, round) {
  const data = readJson(path);
  const meta = data.meta || {};
  const expectedTotal = corpusRows.length * iterations;
  if (
    meta.iterations_per_command !== iterations ||
    meta.commands !== corpusRows.length ||
    meta.total_evaluations !== expectedTotal
  ) {
    throw new Error(`Runde ${round}: unerwarteter Umfang in ${path}`);
  }
  if (meta.node !== process.version || meta.platform !== process.platform || meta.arch !== process.arch) {
    throw new Error(`Runde ${round}: Runtime-Metadaten stimmen nicht mit dem Runner ueberein`);
  }
  for (const layer of ["overall_self", "overall_wall"]) {
    if (!data[layer] || data[layer].n !== expectedTotal) {
      throw new Error(`Runde ${round}: ${layer}.n ist unvollstaendig`);
    }
    for (const metric of ["mean_ms", "p50_ms", "p95_ms", "p99_ms", "min_ms", "max_ms"]) {
      if (!Number.isFinite(data[layer][metric])) {
        throw new Error(`Runde ${round}: ${layer}.${metric} fehlt oder ist ungueltig`);
      }
    }
  }
  if (!Array.isArray(data.per_command) || data.per_command.length !== corpusRows.length) {
    throw new Error(`Runde ${round}: per_command muss ${corpusRows.length} Eintraege enthalten`);
  }
  return data;
}

for (let round = 1; round <= rounds; round += 1) {
  const label = String(round).padStart(2, "0");
  const outputPath = resolve(outputDir, `E3_haw_round_${label}.json`);
  const partialPath = `${outputPath}.partial`;

  if (resume && existsSync(outputPath)) {
    validateRound(outputPath, round);
    console.log(`[E3-HAW] Runde ${round}/${rounds} bereits vollstaendig; uebersprungen`);
  } else {
    if (existsSync(partialPath)) rmSync(partialPath, { force: true });
    console.log(`[E3-HAW] Runde ${round}/${rounds} startet (${corpusRows.length} x ${iterations})`);
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [benchmarkPath, String(iterations), corpusPath, partialPath],
      {
        cwd: EXP,
        env: { ...process.env, GUARDRAIL_SRC: guardrailSrc },
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      throw new Error(`Runde ${round} fehlgeschlagen (exit=${result.status}, signal=${result.signal || "none"})`);
    }
    validateRound(partialPath, round);
    renameSync(partialPath, outputPath);
    console.log(`[E3-HAW] Runde ${round}/${rounds} fertig nach ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }

  const data = validateRound(outputPath, round);
  const entry = {
    round,
    file: outputPath,
    sha256: sha256File(outputPath),
    evaluations: data.meta.total_evaluations,
    node: data.meta.node,
    platform: data.meta.platform,
    arch: data.meta.arch,
    overall_self: data.overall_self,
    overall_wall: data.overall_wall,
  };
  manifest.rounds = manifest.rounds.filter((item) => item.round !== round).concat(entry)
    .sort((a, b) => a.round - b.round);
  manifest.completed_rounds = manifest.rounds.length;
  manifest.runtime.loadavg_latest = os.loadavg();
  atomicJson(manifestPath, manifest);
}

manifest.completed = manifest.rounds.length === rounds;
manifest.completed_at = new Date().toISOString();
manifest.completed_rounds = manifest.rounds.length;
manifest.observed_total_evaluations = manifest.rounds.reduce((sum, item) => sum + item.evaluations, 0);
manifest.runtime.loadavg_at_end = os.loadavg();
atomicJson(manifestPath, manifest);

console.log(
  `[E3-HAW] abgeschlossen: ${manifest.completed_rounds}/${rounds} Runden, ` +
  `${manifest.observed_total_evaluations} Auswertungen`,
);
console.log(`[E3-HAW] Manifest: ${manifestPath}`);
