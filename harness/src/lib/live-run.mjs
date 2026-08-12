import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, copyFile, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildFingerprints } from "./fingerprint.mjs";
import { captureDeployedPluginFingerprint, fingerprintPluginCore } from "./deployed-plugin.mjs";
import { atomicWriteJson } from "./json.mjs";
import { makeLivePlan } from "./live-plan.mjs";
import { loadLiveProfile } from "./live-profile.mjs";
import { buildPilotCompatibility, qualifyPilotRun } from "./main-gate.mjs";
import { loadRegistries, sha256File } from "./registry.mjs";
import { writeMainRunMetricsBundle } from "./run-metrics.mjs";
import { createRun, readRun, registerRunArtifacts, transitionRun, transitionStage, verifyRunArtifacts } from "./run-state.mjs";

const RESULT_FILES = Object.freeze({
  E5: "E5_live_runs.jsonl",
  E6a: "E6_approval_runs.jsonl",
  E6b: "E6b_approval_runs.jsonl",
});

function relativeToRun(runDirectory, file) {
  return path.relative(runDirectory, file).split(path.sep).join("/");
}

async function artifact(runDirectory, role, file, extra = {}) {
  return { role, path: relativeToRun(runDirectory, file), sha256: await sha256File(file), ...extra };
}

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output.sort((left, right) => left.localeCompare(right, "en"));
}

async function snapshotLiveInputs(codeRoot, run, livePlan, profilePath) {
  const profile = profilePath ? await loadLiveProfile(codeRoot, profilePath) : null;
  const sources = [
    ...(profile ? [{ role: "input-profile", source: profile.source, target: "inputs/profile.json" }] : []),
    {
      role: "input-corpus-live",
      source: profile?.corpora.live.readPath ?? path.resolve(codeRoot, livePlan.corpora.live.path),
      target: "inputs/corpora/live.jsonl",
    },
    {
      role: "input-corpus-approval",
      source: profile?.corpora.approval.readPath ?? path.resolve(codeRoot, livePlan.corpora.approval.path),
      target: "inputs/corpora/approval.jsonl",
    },
  ];
  const artifacts = [];
  for (const item of sources) {
    const destination = path.join(run.paths.directory, ...item.target.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(item.source, destination);
    artifacts.push(await artifact(run.paths.directory, item.role, destination));
  }
  return artifacts;
}

async function jsonlRows(file) {
  const text = await readFile(file, "utf8");
  let rows = 0;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch (error) {
      throw new Error(`${file}:${index + 1}: ungültige Ergebnis-JSONL-Zeile (${error.message})`);
    }
    rows += 1;
  }
  return rows;
}

async function syncFile(file) {
  const handle = await open(file, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

export function isTransientGatewayFailure(output) {
  return /gateway closed \(1006|GatewayTransportError:[^\n]*gateway closed|Gateway not yet ready|ECONNREFUSED|no close frame/iu.test(output);
}

function retainDiagnostic(previous, chunk, limit = 128 * 1024) {
  const combined = previous + chunk.toString("utf8");
  return combined.length <= limit ? combined : combined.slice(-limit);
}

export async function runExperimentPhase({ codeRoot, stage, phase, environment, logOutput, outputDirectory }) {
  const script = path.join(codeRoot, phase.script);
  const maxAttempts = Number.isInteger(phase.maxAttempts) && phase.maxAttempts > 0 ? phase.maxAttempts : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await appendFile(logOutput, `\n=== phase ${phase.id}; attempt ${attempt}/${maxAttempts} ===\nscript=${phase.script}\n`, "utf8");
    const stream = createWriteStream(logOutput, { flags: "a" });
    let diagnostic = "";
    const child = spawn("bash", [script], {
      cwd: codeRoot,
      env: { ...process.env, ...environment, ...phase.environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      diagnostic = retainDiagnostic(diagnostic, chunk);
      process.stdout.write(chunk);
      stream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnostic = retainDiagnostic(diagnostic, chunk);
      process.stderr.write(chunk);
      stream.write(chunk);
    });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    await new Promise((resolve, reject) => {
      stream.once("error", reject);
      stream.end(resolve);
    });
    await syncFile(logOutput);
    if (result.code === 0) return { ...result, attempts: attempt };

    const transient = isTransientGatewayFailure(diagnostic);
    if (!transient || attempt === maxAttempts) {
      throw new Error(`${stage.id}/${phase.id}: Runner exit=${result.code} signal=${result.signal ?? "none"}; attempts=${attempt}; transient=${transient}`);
    }

    const waitMs = (phase.retryDelayMs || 12_000) * attempt;
    const retryMessage = `[RETRY] ${stage.id}/${phase.id}: transienter Gateway-Fehler; vollständiger Phasenversuch ${attempt + 1}/${maxAttempts} in ${waitMs} ms\n`;
    await appendFile(logOutput, retryMessage, "utf8");
    process.stdout.write(retryMessage);
    if (outputDirectory) {
      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });
    }
    await delay(waitMs);
  }
  throw new Error(`${stage.id}/${phase.id}: unerreichbarer Retry-Zustand`);
}

export async function executeLivePilot(codeRoot, {
  kind = "pilot",
  requested = [],
  profilePath = null,
  pilotRunId = null,
  stateRoot = codeRoot,
  model = null,
  judgeModel = null,
  judgeBaseUrl = null,
  openclawRepo = process.env.OPENCLAW_REPO ?? null,
  phaseRunner = runExperimentPhase,
  pluginFingerprintProvider = captureDeployedPluginFingerprint,
  allowTestBoundary = false,
  clock = () => new Date(),
} = {}) {
  if (!allowTestBoundary && process.env.HARNESS_RUNTIME !== "host-runner") {
    throw new Error("Live-Ausfuehrung darf nur innerhalb der geprueften Host-Runner-Grenze starten");
  }
  if (!new Set(["pilot", "main"]).has(kind)) throw new Error("Live-Ausfuehrung erwartet kind=pilot oder kind=main");
  if (kind === "main" && !profilePath) throw new Error("Live-Main erfordert ein explizites Main-Profil");
  if (kind === "main" && !pilotRunId) throw new Error("Live-Main erfordert --pilot-run RUN-ID");
  if (typeof openclawRepo !== "string" || !path.isAbsolute(openclawRepo)) {
    throw new Error("OPENCLAW_REPO muss als absoluter Pfad gesetzt sein");
  }
  const livePlan = await makeLivePlan(codeRoot, { kind, requested, profilePath });
  const resolvedModel = model ?? livePlan.models?.agent ?? process.env.MODEL ?? "qwen3:30b";
  const resolvedJudgeModel = judgeModel ?? livePlan.models?.judge ?? process.env.JUDGE_MODEL ?? "qwen3:30b";
  const resolvedJudgeBaseUrl = judgeBaseUrl ?? livePlan.models?.judgeBaseUrl ?? process.env.JUDGE_BASE_URL ?? "http://ollama:11434";
  const [deployedPlugin, measurementBaselinePlugin] = await Promise.all([
    pluginFingerprintProvider(openclawRepo),
    fingerprintPluginCore(path.join(codeRoot, "vendor", "plugin-baseline")),
  ]);
  const pluginProvenance = {
    deployed: deployedPlugin,
    measurementBaseline: measurementBaselinePlugin,
    byteIdenticalToMeasurementBaseline: deployedPlugin.sha256 === measurementBaselinePlugin.sha256,
    matchesMeasurementBaseline:
      deployedPlugin.normalizedTextSha256 === measurementBaselinePlugin.normalizedTextSha256,
  };
  const registries = await loadRegistries(codeRoot);
  const fingerprints = await buildFingerprints(codeRoot, registries, livePlan.stages, kind, {
    models: { agent: resolvedModel, judge: resolvedJudgeModel },
    configuration: {
      executionBoundary: livePlan.executionBoundary,
      openclawRepo,
      judgeBaseUrl: resolvedJudgeBaseUrl,
      pluginProvenance,
      livePlan,
    },
  });
  const pilotCompatibility = buildPilotCompatibility(fingerprints, livePlan, pluginProvenance);
  const pilotQualification = kind === "main"
    ? await qualifyPilotRun(stateRoot, pilotRunId, pilotCompatibility)
    : null;
  const run = await createRun(stateRoot, {
    kind,
    plan: livePlan.stages,
    fingerprints,
    metadata: {
      liveOnly: true,
      preparedOnly: false,
      mainRunAllowed: kind === "main",
      model: resolvedModel,
      judgeModel: resolvedJudgeModel,
      judgeBaseUrl: resolvedJudgeBaseUrl,
      openclawRepo,
      expectedRows: livePlan.expectedRows,
      profile: livePlan.profile,
      pluginProvenance,
      measurementContract: livePlan.measurementContract,
      pilotCompatibility,
      pilotQualification,
    },
    clock,
  });

  try {
    const inputArtifacts = await snapshotLiveInputs(codeRoot, run, livePlan, profilePath);
    await registerRunArtifacts(stateRoot, run.manifest.runId, inputArtifacts, {
      note: "validated profile and corpora snapshotted before live mutation",
      clock,
    });
    await transitionRun(stateRoot, run.manifest.runId, "preflight", { note: "host preflight passed before container start", clock });
    await transitionRun(stateRoot, run.manifest.runId, "ready", { clock });
    await transitionRun(stateRoot, run.manifest.runId, "running", { clock });

    for (const stage of livePlan.stages) {
      await transitionStage(stateRoot, run.manifest.runId, stage.id, "running", { clock });
      const outputDirectory = path.join(run.paths.raw, stage.id);
      const resultOutput = path.join(outputDirectory, RESULT_FILES[stage.id]);
      const logOutput = path.join(run.paths.logs, `${stage.id}.log`);
      const summaryOutput = path.join(run.paths.derived, stage.id, "execution-summary.json");
      await mkdir(outputDirectory, { recursive: true });
      await mkdir(path.dirname(summaryOutput), { recursive: true });
      await appendFile(logOutput, `adapter=live-via-host-runner\nstage=${stage.id}\n`, "utf8");
      let expectedCumulative = 0;
      const completedPhases = [];
      try {
        for (const phase of stage.phases) {
          const phaseResult = await phaseRunner({
            codeRoot,
            run,
            stage,
            phase,
            logOutput,
            outputDirectory,
            resultOutput,
            environment: {
              OUTDIR: outputDirectory,
              OPENCLAW_REPO: openclawRepo,
              MODEL: resolvedModel,
              JUDGE_MODEL: resolvedJudgeModel,
              JUDGE_BASE_URL: resolvedJudgeBaseUrl,
            },
          });
          expectedCumulative += phase.expectedRows;
          const observedRows = await jsonlRows(resultOutput);
          if (observedRows !== expectedCumulative) {
            throw new Error(`${stage.id}/${phase.id}: ${observedRows} Ergebniszeilen, erwartet ${expectedCumulative}`);
          }
          completedPhases.push({
            id: phase.id,
            expectedRows: phase.expectedRows,
            observedCumulativeRows: observedRows,
            attempts: phaseResult?.attempts ?? 1,
          });
        }
        const observedRows = await jsonlRows(resultOutput);
        if (observedRows !== stage.expectedRows) throw new Error(`${stage.id}: ${observedRows} Zeilen, erwartet ${stage.expectedRows}`);
        await atomicWriteJson(summaryOutput, {
          schemaVersion: 1,
          experimentId: stage.id,
          kind,
          adapter: "live-via-host-runner",
          expectedRows: stage.expectedRows,
          observedRows,
          phases: completedPhases,
          model: resolvedModel,
          judgeModel: resolvedJudgeModel,
          openclawRepo,
        });
        const artifacts = [
          await artifact(run.paths.directory, "raw-results", resultOutput, { rows: observedRows }),
          await artifact(run.paths.directory, "stage-summary", summaryOutput),
          await artifact(run.paths.directory, "stage-log", logOutput),
        ];
        for (const file of await filesBelow(outputDirectory)) {
          if (file === resultOutput) continue;
          artifacts.push(await artifact(run.paths.directory, "raw-capture", file));
        }
        await transitionStage(stateRoot, run.manifest.runId, stage.id, "succeeded", {
          artifacts,
          note: `${observedRows} Ergebniszeilen; ${artifacts.length} Artefakte mit SHA-256 registriert`,
          clock,
        });
      } catch (error) {
        await appendFile(logOutput, `\n[FEHLER] ${error.stack ?? error.message}\n`, "utf8");
        await syncFile(logOutput);
        await transitionStage(stateRoot, run.manifest.runId, stage.id, "failed", { error: error.message, clock });
        throw error;
      }
    }
    let verification = await verifyRunArtifacts(stateRoot, run.manifest.runId);
    if (!verification.ok) throw new Error(`Live-Artefaktprüfung fehlgeschlagen: ${verification.errors.join("; ")}`);
    if (kind === "main") {
      await transitionRun(stateRoot, run.manifest.runId, "analyzing", {
        note: "profile-defined main metrics generation",
        clock,
      });
      const metricsOutput = path.join(run.paths.derived, "metrics.bundle.json");
      const metrics = await writeMainRunMetricsBundle(stateRoot, run.manifest.runId, metricsOutput);
      await registerRunArtifacts(stateRoot, run.manifest.runId, [{
        role: "run-metrics",
        path: relativeToRun(run.paths.directory, metrics.output),
        sha256: metrics.sha256,
        rows: livePlan.expectedRows,
      }], { clock });
      verification = await verifyRunArtifacts(stateRoot, run.manifest.runId);
      if (!verification.ok) throw new Error(`Main-Metrikartefaktprüfung fehlgeschlagen: ${verification.errors.join("; ")}`);
    }
    await transitionRun(stateRoot, run.manifest.runId, "completed", { clock });
    return readRun(stateRoot, run.manifest.runId);
  } catch (error) {
    const current = await readRun(stateRoot, run.manifest.runId).catch(() => null);
    if (current && !["failed", "interrupted", "completed"].includes(current.status.state)) {
      await transitionRun(stateRoot, run.manifest.runId, "failed", { error: error.message, clock });
    }
    error.runId = run.manifest.runId;
    throw error;
  }
}
