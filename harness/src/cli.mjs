#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFingerprints } from "./lib/fingerprint.mjs";
import { loadPolicyCorpus } from "./lib/corpus.mjs";
import { executeOfflineRun } from "./lib/offline-run.mjs";
import { executeJudgeRun } from "./lib/judge-run.mjs";
import { makeLivePlan } from "./lib/live-plan.mjs";
import { executeLivePilot } from "./lib/live-run.mjs";
import { captureDeployedPluginFingerprint, fingerprintPluginCore } from "./lib/deployed-plugin.mjs";
import { writeReferenceMetricsBundle } from "./lib/metrics-bundle.mjs";
import { loadRegistries, treeInventory, validateRegistries, verifyCorpusHashes } from "./lib/registry.mjs";
import { makePlan, selectExperiments } from "./lib/plan.mjs";
import { createRun, listRuns, readRun, verifyRunArtifacts } from "./lib/run-state.mjs";
import { buildRunSummary } from "./lib/run-summary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_ROOT = process.env.HARNESS_STATE_ROOT
  ? path.resolve(process.env.HARNESS_STATE_ROOT)
  : ROOT;
const [command = "help", ...args] = process.argv.slice(2);

function help() {
  console.log(`Guardrail Harness (development control plane)

Usage:
  harness doctor
  harness list
  harness plan [--pilot] [--all|E1 E4 ...]
  harness prepare <pilot|main> [--all|E1 E4 ...]
  harness offline <pilot|main> [E1 E1ext E2 E3 ...]
  harness judge <pilot|main> [E4] [--mock]
  harness judge resume <run-id>
  harness live plan <pilot|main> [E5 E6a E6b]
  harness live plan --profile <profil.json> [E5 E6a E6b]
  harness live preflight             (über bin/harness, read-only)
  harness live plugin-info           (deployter Plugin-Hash, read-only)
  harness live pilot [E5 E6a E6b]    (nur nach grünem Host-Preflight)
  harness live pilot --profile <profil.json>
  harness live main --profile <main-profil.json> --pilot-run <run-id>
  harness profile validate <profil.json>
  harness metrics reference [--output <metrics.bundle.json>]
  harness metrics run <main-run-id>
  harness validate-corpus <datei.jsonl>
  harness status [run-id] [--json]
  harness verify <run-id>
  harness summarize <run-id> [--json]
  harness host-info                 (über bin/harness)
  harness pilot|run|all|resume   (noch gesperrt)
`);
}

function commandVersion(name, versionArgs = ["--version"]) {
  const result = spawnSync(name, versionArgs, { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split("\n")[0];
}

function profileArgument(values) {
  const indexes = values.map((value, index) => value === "--profile" ? index : -1).filter((index) => index >= 0);
  if (!indexes.length) return { profilePath: null, remaining: [...values] };
  if (indexes.length !== 1) throw new Error("--profile darf nur einmal angegeben werden");
  const index = indexes[0];
  if (!values[index + 1] || values[index + 1].startsWith("--")) throw new Error("--profile erwartet einen JSON-Pfad");
  return {
    profilePath: values[index + 1],
    remaining: values.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1),
  };
}

function pilotRunArgument(values) {
  const indexes = values.map((value, index) => value === "--pilot-run" ? index : -1).filter((index) => index >= 0);
  if (!indexes.length) return { pilotRunId: null, remaining: [...values] };
  if (indexes.length !== 1) throw new Error("--pilot-run darf nur einmal angegeben werden");
  const index = indexes[0];
  if (!values[index + 1] || values[index + 1].startsWith("--")) throw new Error("--pilot-run erwartet eine Run-ID");
  return {
    pilotRunId: values[index + 1],
    remaining: values.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1),
  };
}

async function doctor() {
  const registries = await loadRegistries(ROOT);
  const errors = await validateRegistries(ROOT, registries);
  errors.push(...await verifyCorpusHashes(ROOT, registries));
  const expected = registries.snapshots.experimentRunners;
  const inventory = await treeInventory(path.join(ROOT, expected.copy));
  if (inventory.files !== expected.files) errors.push(`runner inventory file count: ${inventory.files} != ${expected.files}`);
  if (inventory.sha256 !== expected.inventorySha256) errors.push("runner inventory SHA-256 mismatch");

  console.log(`Harness root: ${ROOT}`);
  console.log(`Node:         ${process.version}`);
  console.log(`Docker:       ${commandVersion("docker") ?? "nicht gefunden"}`);
  console.log(`Compose:      ${commandVersion("docker", ["compose", "version"]) ?? "nicht gefunden"}`);
  console.log(`Registry:     ${errors.length ? "FEHLER" : "ok"}`);
  console.log(`Runner-Inventar: ${inventory.files} Dateien, ${inventory.sha256}`);
  const runtimeLock = await readFile(path.join(ROOT, "runtime", "image-lock.json"), "utf8").then(JSON.parse);
  console.log(`Runtime lock: ${runtimeLock.status}`);
  if (runtimeLock.status !== "released") {
    console.log("Hinweis:      Runtime-Image ist noch nicht für einen HAW-Hauptlauf fixiert.");
  }
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}

async function list() {
  const { experiments } = await loadRegistries(ROOT);
  const rows = experiments.canonicalOrder.map((id) => {
    const item = experiments.experiments[id];
    return {
      ID: id,
      Ebene: item.level,
      Runner: item.runner,
      Korpus: item.corpus ?? "—",
      Titel: item.title,
    };
  });
  console.table(rows);
}

async function plan() {
  const { experiments } = await loadRegistries(ROOT);
  const pilot = args.includes("--pilot");
  const requested = args.filter((arg) => arg !== "--pilot");
  const selected = selectExperiments(experiments, requested);
  console.log(JSON.stringify({ mode: pilot ? "pilot" : "full", stages: makePlan(experiments, selected, pilot) }, null, 2));
}

async function prepare() {
  const kind = args[0];
  if (!new Set(["pilot", "main"]).has(kind)) {
    throw new Error("prepare erwartet 'pilot' oder 'main'");
  }
  const requested = args.slice(1);
  const registries = await loadRegistries(ROOT);
  const registryErrors = await validateRegistries(ROOT, registries);
  registryErrors.push(...await verifyCorpusHashes(ROOT, registries));
  if (registryErrors.length) throw new Error(`Registry-Preflight fehlgeschlagen: ${registryErrors.join("; ")}`);
  const selected = selectExperiments(registries.experiments, requested);
  const stages = makePlan(registries.experiments, selected, kind === "pilot");
  const fingerprints = await buildFingerprints(ROOT, registries, stages, kind, {
    models: {
      agent: process.env.MODEL ?? "qwen3:30b",
      judge: process.env.JUDGE_MODEL ?? "qwen3:30b",
    },
    configuration: {
      openclawRepo: process.env.OPENCLAW_REPO ?? null,
    },
  });
  const created = await createRun(STATE_ROOT, {
    kind,
    plan: stages,
    fingerprints,
    metadata: {
      preparedOnly: true,
      preparedBy: "harness prepare",
    },
  });
  console.log(`Run vorbereitet: ${created.manifest.runId}`);
  console.log(`Status:          ${created.status.state}`);
  console.log(`Verzeichnis:     ${created.paths.directory}`);
  console.log("Es wurde keine Experimentstufe ausgeführt.");
}

async function status() {
  const json = args.includes("--json");
  const requested = args.find((arg) => arg !== "--json");
  if (requested) {
    const run = await readRun(STATE_ROOT, requested);
    if (json) console.log(JSON.stringify({ manifest: run.manifest, status: run.status }, null, 2));
    else {
      console.log(`Run:       ${run.status.runId}`);
      console.log(`Art:       ${run.status.kind}`);
      console.log(`Status:    ${run.status.state}`);
      console.log(`Revision:  ${run.status.revision}`);
      console.log(`Aktual.:   ${run.status.updatedAt}`);
      console.table(run.status.stages.map((stage) => ({
        Stufe: stage.id,
        Status: stage.status,
        Versuche: stage.attempts,
        Fehler: stage.lastError ?? "",
      })));
    }
    return;
  }
  const runs = await listRuns(STATE_ROOT);
  if (!runs.length) console.log("Noch keine Runs vorhanden.");
  else if (json) console.log(JSON.stringify(runs, null, 2));
  else console.table(runs.map((run) => ({
    Run: run.runId,
    Art: run.kind ?? "?",
    Status: run.state,
    Revision: run.revision ?? "?",
    Aktualisiert: run.updatedAt ?? "?",
  })));
}

async function validateCorpus() {
  if (args.length !== 1) throw new Error("validate-corpus erwartet genau einen JSONL-Pfad");
  const corpus = await loadPolicyCorpus(path.resolve(args[0]));
  const suites = Object.fromEntries([...corpus.cases.reduce((counts, row) => {
    counts.set(row.suite, (counts.get(row.suite) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].sort());
  console.log(`Korpus:  ${corpus.source}`);
  console.log(`Format:  ${corpus.format}`);
  console.log(`Fälle:   ${corpus.cases.length}`);
  console.log(`SHA-256: ${corpus.sha256}`);
  console.log(`Suites:  ${JSON.stringify(suites)}`);
}

async function offline() {
  const kind = args[0];
  const requested = args.slice(1);
  const run = await executeOfflineRun(ROOT, { kind, requested, stateRoot: STATE_ROOT });
  console.log(`Offline-Run abgeschlossen: ${run.status.runId}`);
  console.log(`Art:                     ${run.status.kind}`);
  console.log(`Status:                  ${run.status.state}`);
  console.log(`Verzeichnis:             ${run.paths.directory}`);
  console.table(run.status.stages.map((stage) => ({
    Stufe: stage.id,
    Status: stage.status,
    Versuche: stage.attempts,
    Artefakte: stage.artifacts?.length ?? 0,
  })));
}

async function verify() {
  if (args.length !== 1) throw new Error("verify erwartet genau eine Run-ID");
  const result = await verifyRunArtifacts(STATE_ROOT, args[0]);
  console.log(`Artefakte geprüft: ${result.checked}`);
  console.log(`Integrität:          ${result.ok ? "ok" : "FEHLER"}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}

function percent(value) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)} %`;
}

async function summarize() {
  const json = args.includes("--json");
  const runId = args.find((argument) => argument !== "--json");
  if (!runId || args.filter((argument) => argument !== "--json").length !== 1) {
    throw new Error("summarize erwartet genau eine Run-ID und optional --json");
  }
  const summary = await buildRunSummary(STATE_ROOT, runId);
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Run:                  ${summary.runId}`);
    console.log(`Art:                  ${summary.kind}`);
    console.log(`Status:               ${summary.state}`);
    console.log(`Artefaktintegrität:   ${summary.integrity.ok ? `ok (${summary.integrity.checked})` : "FEHLER"}`);
    console.log(`Pilot-Technikgate:    ${summary.pilotTechnicalGate.status}`);
    if (summary.kind === "main") {
      console.log(`Pilot-Qualifikation:  ${summary.pilotQualification?.status ?? "failed"}`);
      console.log(`Metrikartefakt:       ${summary.metricsArtifact?.path ?? "fehlt"}`);
    }
    console.log(`Finalmetrik-Eignung:  ${summary.eligibleAsFinalMetrics ? "ja" : "nein"}`);
    console.table(summary.stages.map((stage) => ({
      Stufe: stage.experimentId,
      Zeilen: stage.total ?? "—",
      Erreicht: stage.reached ?? stage.toolCalled ?? "—",
      Refusals: stage.refusals ?? stage.noToolCall ?? "—",
      Valide: stage.valid ?? "—",
      "Bedingte Fidelity": percent(stage.conditionalFidelity),
    })));
    for (const check of summary.pilotTechnicalGate.checks) {
      console.log(`${check.passed ? "[OK]" : "[FEHLER]"} ${check.id}: ${JSON.stringify(check.observed)}`);
    }
    for (const reason of summary.finalMetricsExclusionReasons) console.log(`[FINALMETRIK AUSGESCHLOSSEN] ${reason}`);
  }
  if (!summary.integrity.ok || summary.pilotTechnicalGate.status === "failed") process.exitCode = 1;
}

function judgeConfigurationFromEnvironment() {
  return {
    models: (process.env.JUDGE_MODELS || process.env.JUDGE_MODEL || "qwen3:30b")
      .split(",").map((value) => value.trim()).filter(Boolean),
    baseUrl: process.env.JUDGE_BASE_URL || "http://ollama:11434",
    timeoutMs: Number(process.env.JUDGE_TIMEOUT_MS || 60000),
    minConfidence: process.env.JUDGE_MIN_CONFIDENCE || "medium",
    maxFallbackRate: Number(process.env.JUDGE_MAX_FALLBACK_RATE || 0.05),
  };
}

async function judge() {
  if (args[0] === "resume") {
    if (args.length < 2 || args.length > 3 || (args.length === 3 && args[2] !== "--mock")) {
      throw new Error("judge resume erwartet eine Run-ID und optional --mock");
    }
    const run = await executeJudgeRun(ROOT, {
      stateRoot: STATE_ROOT,
      resumeRunId: args[1],
    });
    console.log(`Judge-Run fortgesetzt: ${run.status.runId}`);
    console.log(`Status:                ${run.status.state}`);
    return;
  }
  const kind = args[0];
  const mock = args.includes("--mock");
  const requested = args.slice(1).filter((argument) => argument !== "--mock");
  const run = await executeJudgeRun(ROOT, {
    kind,
    requested,
    stateRoot: STATE_ROOT,
    mock,
    ...judgeConfigurationFromEnvironment(),
  });
  console.log(`Judge-Run abgeschlossen: ${run.status.runId}`);
  console.log(`Art:                   ${run.status.kind}`);
  console.log(`Status:                ${run.status.state}`);
  console.log(`Mock:                  ${run.manifest.metadata.judgeConfiguration.mock}`);
  console.log(`Verzeichnis:           ${run.paths.directory}`);
  console.table(run.status.stages.map((stage) => ({
    Stufe: stage.id,
    Status: stage.status,
    Versuche: stage.attempts,
    Artefakte: stage.artifacts?.length ?? 0,
  })));
}

async function live() {
  if (args[0] === "plugin-info") {
    if (process.env.HARNESS_RUNTIME !== "host-runner") {
      throw new Error("live plugin-info darf nur innerhalb der geprueften Host-Runner-Grenze starten");
    }
    const openclawRepo = process.env.OPENCLAW_REPO;
    if (typeof openclawRepo !== "string" || !path.isAbsolute(openclawRepo)) {
      throw new Error("OPENCLAW_REPO muss als absoluter Pfad gesetzt sein");
    }
    const [deployed, measurementBaseline] = await Promise.all([
      Promise.resolve(captureDeployedPluginFingerprint(openclawRepo)),
      fingerprintPluginCore(path.join(ROOT, "vendor", "plugin-baseline")),
    ]);
    console.log(JSON.stringify({
      schemaVersion: 1,
      pluginId: deployed.pluginId,
      deployed,
      measurementBaseline,
      byteIdenticalToMeasurementBaseline: deployed.sha256 === measurementBaseline.sha256,
      matchesMeasurementBaseline:
        deployed.normalizedTextSha256 === measurementBaseline.normalizedTextSha256,
    }, null, 2));
    return;
  }
  if (args[0] === "plan") {
    const parsed = profileArgument(args.slice(1));
    const kind = parsed.profilePath ? undefined : parsed.remaining[0];
    const requested = parsed.profilePath ? parsed.remaining : parsed.remaining.slice(1);
    console.log(JSON.stringify(await makeLivePlan(ROOT, { kind, requested, profilePath: parsed.profilePath }), null, 2));
    return;
  }
  if (new Set(["pilot", "main"]).has(args[0])) {
    const kind = args[0];
    const parsed = profileArgument(args.slice(1));
    const pilot = pilotRunArgument(parsed.remaining);
    if (kind === "pilot" && pilot.pilotRunId) throw new Error("--pilot-run ist nur fuer live main erlaubt");
    const run = await executeLivePilot(ROOT, {
      kind,
      requested: pilot.remaining,
      profilePath: parsed.profilePath,
      pilotRunId: pilot.pilotRunId,
      stateRoot: STATE_ROOT,
    });
    console.log(`Live-${kind === "pilot" ? "Pilot" : "Main"} abgeschlossen: ${run.status.runId}`);
    console.log(`Status:                  ${run.status.state}`);
    console.log(`Verzeichnis:             ${run.paths.directory}`);
    console.table(run.status.stages.map((stage) => ({
      Stufe: stage.id,
      Status: stage.status,
      Versuche: stage.attempts,
      Artefakte: stage.artifacts?.length ?? 0,
    })));
    return;
  }
  throw new Error("Erlaubt sind 'live plugin-info', 'live plan', 'live pilot' und das Pilot-Gate-gesicherte 'live main'");
}

async function profile() {
  if (!new Set(["validate", "models"]).has(args[0]) || args.length !== 2) {
    throw new Error("profile erwartet 'validate' oder 'models' und genau einen Profilpfad");
  }
  const plan = await makeLivePlan(ROOT, { profilePath: args[1] });
  if (args[0] === "models") {
    console.log(plan.models.agent);
    console.log(plan.models.judge);
    console.log(plan.models.judgeBaseUrl);
    return;
  }
  console.log(`Profil:       ${plan.profile.name}`);
  console.log(`Datei:        ${plan.profile.path}`);
  console.log(`SHA-256:      ${plan.profile.sha256}`);
  console.log(`Art:          ${plan.kind}`);
  console.log(`Experimente:  ${plan.stages.map((stage) => stage.id).join(", ")}`);
  console.log(`Korpora:      live=${plan.corpora.live.cases} (${plan.corpora.live.root}:${plan.corpora.live.path}), approval=${plan.corpora.approval.cases} (${plan.corpora.approval.root}:${plan.corpora.approval.path})`);
  console.log(`Erwartet:     ${plan.expectedRows} Ergebniszeilen`);
  console.log("Status:       gültig");
}

async function metrics() {
  if (args[0] === "run") {
    if (args.length !== 2) throw new Error("metrics run erwartet genau eine Haupt-Run-ID");
    const run = await readRun(STATE_ROOT, args[1]);
    if (run.status.kind !== "main") throw new Error(`${args[1]} ist kein Hauptlauf`);
    if (run.status.state !== "completed") throw new Error(`${args[1]} ist nicht abgeschlossen`);
    const integrity = await verifyRunArtifacts(STATE_ROOT, args[1]);
    if (!integrity.ok) throw new Error(`Artefaktintegrität fehlgeschlagen: ${integrity.errors.join("; ")}`);
    const artifact = (run.status.artifacts ?? []).find((candidate) => candidate.role === "run-metrics");
    if (!artifact) throw new Error(`Registriertes Metrikartefakt fehlt: ${args[1]}`);
    const summary = await buildRunSummary(STATE_ROOT, args[1]);
    if (!summary.eligibleAsFinalMetrics) {
      throw new Error(`Hauptlauf ist nicht als profilgebundene Finalmetrik freigegeben: ${summary.finalMetricsExclusionReasons.join("; ")}`);
    }
    console.log(`Run:            ${args[1]}`);
    console.log(`Metrik-Bundle:  ${path.join(run.paths.directory, artifact.path)}`);
    console.log(`SHA-256:        ${artifact.sha256}`);
    console.log("Status:         freigegeben für den exakt dokumentierten Profilumfang");
    console.log("Repräsentativ:  nein; technische Beispielmessung");
    return;
  }
  if (args[0] !== "reference") {
    throw new Error("Erlaubt: metrics reference [--output <pfad>] | metrics run <main-run-id>");
  }
  const outputIndex = args.indexOf("--output");
  if (outputIndex >= 0 && (outputIndex !== args.length - 2 || !args[outputIndex + 1])) {
    throw new Error("--output erwartet genau einen abschließenden Pfad");
  }
  const unknown = args.slice(1).filter((argument, index) => argument !== "--output" && (outputIndex < 0 || index + 1 !== outputIndex + 1));
  if (unknown.length) throw new Error(`Unbekannte metrics-Argumente: ${unknown.join(", ")}`);
  const output = outputIndex >= 0
    ? path.resolve(args[outputIndex + 1])
    : path.join(STATE_ROOT, "artifacts", "metrics", "reference", "metrics.bundle.json");
  const result = await writeReferenceMetricsBundle(ROOT, output);
  console.log(`Metrik-Bundle: ${result.output}`);
  console.log(`SHA-256:       ${result.sha256}`);
  console.log("Status:        autoritative Golden-Referenz; keine neue Haupt-Run-ID");
}

try {
  if (command === "help" || command === "--help" || command === "-h") help();
  else if (command === "doctor") await doctor();
  else if (command === "list") await list();
  else if (command === "plan") await plan();
  else if (command === "prepare") await prepare();
  else if (command === "offline") await offline();
  else if (command === "judge") await judge();
  else if (command === "live") await live();
  else if (command === "profile") await profile();
  else if (command === "metrics") await metrics();
  else if (command === "validate-corpus") await validateCorpus();
  else if (command === "status") await status();
  else if (command === "verify") await verify();
  else if (command === "summarize") await summarize();
  else if (["pilot", "run", "all", "resume"].includes(command)) {
    console.error(`${command}: Ausführungsadapter noch nicht freigegeben; es wurde nichts gestartet.`);
    process.exitCode = 3;
  } else {
    console.error(`Unbekannter Befehl: ${command}`);
    help();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`[FEHLER] ${error.message}`);
  process.exitCode = 1;
}
