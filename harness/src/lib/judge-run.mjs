import path from "node:path";
import { runJudgeOffline } from "../adapters/judge-offline.mjs";
import { buildFingerprints } from "./fingerprint.mjs";
import { atomicWriteText } from "./json.mjs";
import { makePlan, selectExperiments } from "./plan.mjs";
import { loadRegistries, sha256File, validateRegistries, verifyCorpusHashes } from "./registry.mjs";
import {
  createRun,
  isRunLocked,
  readRun,
  recoverRun,
  transitionRun,
  transitionStage,
  verifyRunArtifacts,
} from "./run-state.mjs";

const JUDGE_EXPERIMENTS = new Set(["E4"]);

function relativeToRun(runDirectory, file) {
  return path.relative(runDirectory, file).split(path.sep).join("/");
}

async function artifact(runDirectory, role, file, extra = {}) {
  return {
    role,
    path: relativeToRun(runDirectory, file),
    sha256: await sha256File(file),
    ...extra,
  };
}

function normalizedConfiguration(options) {
  const models = options.models?.map((model) => String(model).trim()).filter(Boolean) ?? ["qwen3:30b"];
  return {
    models,
    baseUrl: String(options.baseUrl ?? "http://ollama:11434").replace(/\/+$/u, ""),
    timeoutMs: Number(options.timeoutMs ?? 60000),
    minConfidence: options.minConfidence ?? "medium",
    maxFallbackRate: Number(options.maxFallbackRate ?? 0.05),
    mock: Boolean(options.mock),
  };
}

async function preflight(codeRoot, requested, kind, configuration) {
  const registries = await loadRegistries(codeRoot);
  const errors = await validateRegistries(codeRoot, registries);
  errors.push(...await verifyCorpusHashes(codeRoot, registries));
  if (errors.length) throw new Error(`Judge-Preflight fehlgeschlagen: ${errors.join("; ")}`);
  const selected = selectExperiments(registries.experiments, requested.length ? requested : ["E4"]);
  const unsupported = selected.filter((id) => !JUDGE_EXPERIMENTS.has(id));
  if (unsupported.length) throw new Error(`Noch keine produktive Judge-Adapterfreigabe für: ${unsupported.join(", ")}`);
  if (configuration.mock && kind !== "pilot") throw new Error("Mock-Judge ist ausschließlich für Pilot-/Vertragstests zulässig");
  const plan = makePlan(registries.experiments, selected, kind === "pilot");
  const fingerprints = await buildFingerprints(codeRoot, registries, plan, kind, {
    models: { judge: configuration.models },
    configuration: {
      executionBoundary: configuration.mock ? "offline-no-network-mock" : "judge-network",
      judge: configuration,
    },
  });
  return { registries, selected, plan, fingerprints };
}

async function createOrResumeRun(codeRoot, stateRoot, options, configuration, clock) {
  if (!options.resumeRunId) {
    const prepared = await preflight(codeRoot, options.requested ?? [], options.kind, configuration);
    const run = await createRun(stateRoot, {
      kind: options.kind,
      plan: prepared.plan,
      fingerprints: prepared.fingerprints,
      metadata: {
        judgeOnly: true,
        preparedOnly: false,
        judgeConfiguration: configuration,
      },
      clock,
    });
    await transitionRun(stateRoot, run.manifest.runId, "preflight", { clock });
    await transitionRun(stateRoot, run.manifest.runId, "ready", { clock });
    await transitionRun(stateRoot, run.manifest.runId, "running", { clock });
    return { run, ...prepared, resume: false };
  }

  let run = await readRun(stateRoot, options.resumeRunId);
  if (!run.manifest.metadata?.judgeOnly) throw new Error("Run ist kein Judge-Run");
  const saved = run.manifest.metadata.judgeConfiguration;
  const prepared = await preflight(
    codeRoot,
    run.manifest.plan.map((stage) => stage.id),
    run.manifest.kind,
    saved,
  );
  if (prepared.fingerprints.executionFingerprint !== run.manifest.fingerprints.executionFingerprint) {
    throw new Error("Judge-Resume abgelehnt: Ausführungsfingerprint hat sich geändert");
  }
  if (run.status.state === "running") {
    if (await isRunLocked(stateRoot, run.status.runId)) throw new Error("Judge-Run ist noch aktiv gesperrt");
    await transitionRun(stateRoot, run.status.runId, "interrupted", {
      note: "verwaister running-Status vor Resume",
      clock,
    });
  }
  run = await readRun(stateRoot, run.status.runId);
  if (["failed", "interrupted"].includes(run.status.state)) {
    await recoverRun(stateRoot, run.status.runId, { note: "judge resume", clock });
  } else if (run.status.state !== "ready") {
    throw new Error(`Judge-Run kann aus Status ${run.status.state} nicht fortgesetzt werden`);
  }
  await transitionRun(stateRoot, run.status.runId, "running", { note: "judge resume", clock });
  run = await readRun(stateRoot, run.status.runId);
  return { run, ...prepared, configuration: saved, resume: true };
}

export async function executeJudgeRun(codeRoot, {
  kind = null,
  requested = [],
  stateRoot = codeRoot,
  models = ["qwen3:30b"],
  baseUrl = "http://ollama:11434",
  timeoutMs = 60000,
  minConfidence = "medium",
  maxFallbackRate = 0.05,
  mock = false,
  resumeRunId = null,
  fetchFactory = null,
  probeFetch = globalThis.fetch,
  clock = () => new Date(),
} = {}) {
  if (!resumeRunId && !new Set(["pilot", "main"]).has(kind)) throw new Error("Judge-Run erwartet 'pilot' oder 'main'");
  const configuration = normalizedConfiguration({
    models, baseUrl, timeoutMs, minConfidence, maxFallbackRate, mock,
  });
  const prepared = await createOrResumeRun(codeRoot, stateRoot, {
    kind, requested, resumeRunId,
  }, configuration, clock);
  const { run, registries, plan, resume } = prepared;
  const activeConfiguration = prepared.configuration ?? configuration;

  try {
    for (const stage of plan) {
      if (run.status.stages.find((item) => item.id === stage.id)?.status === "succeeded") continue;
      await transitionStage(stateRoot, run.manifest.runId, stage.id, "running", { clock });
      const experiment = registries.experiments.experiments[stage.id];
      const corpus = registries.corpora.corpora[experiment.corpus];
      const rawOutput = path.join(run.paths.raw, stage.id, "results.jsonl");
      const summaryOutput = path.join(run.paths.derived, stage.id, "summary.json");
      const logOutput = path.join(run.paths.logs, `${stage.id}.log`);
      try {
        const result = await runJudgeOffline({
          experimentId: stage.id,
          corpusPaths: (corpus.paths ?? [corpus.path]).map((item) => path.join(codeRoot, item)),
          corpusReference: corpus.paths ?? corpus.path,
          policySource: path.join(codeRoot, "vendor/plugin-baseline/src/policy.js"),
          judgeSource: path.join(codeRoot, "vendor/plugin-baseline/src/judge.js"),
          rawOutput,
          summaryOutput,
          expectedCases: corpus.cases,
          expectedEligibleCases: experiment.expected.cases,
          caseLimit: run.manifest.kind === "pilot" ? stage.parameters.cases : null,
          models: activeConfiguration.models,
          repetitions: stage.parameters.repetitions,
          baseUrl: activeConfiguration.baseUrl,
          timeoutMs: activeConfiguration.timeoutMs,
          minConfidence: activeConfiguration.minConfidence,
          maxFallbackRate: activeConfiguration.maxFallbackRate,
          mock: activeConfiguration.mock,
          resume,
          fetchFactory,
          probeFetch,
        });
        await atomicWriteText(logOutput, [
          `adapter=judge-offline`,
          `mock=${result.summary.mock}`,
          `eligible_cases=${result.eligible.length}`,
          `selected_cases=${result.selected.length}`,
          `calls=${result.rows.length}`,
          `configuration_signature=${result.configuration.signature}`,
          "",
        ].join("\n"));
        const artifacts = [
          await artifact(run.paths.directory, "raw-results", rawOutput, { rows: result.rows.length }),
          await artifact(run.paths.directory, "stage-summary", summaryOutput),
          await artifact(run.paths.directory, "stage-log", logOutput),
        ];
        await transitionStage(stateRoot, run.manifest.runId, stage.id, "succeeded", {
          artifacts,
          note: `${artifacts.length} Judge-Artefakte mit SHA-256 registriert`,
          clock,
        });
      } catch (error) {
        await atomicWriteText(logOutput, `${error.stack ?? error.message}\n`);
        await transitionStage(stateRoot, run.manifest.runId, stage.id, "failed", {
          error: error.message,
          clock,
        });
        throw error;
      }
    }
    const verification = await verifyRunArtifacts(stateRoot, run.manifest.runId);
    if (!verification.ok) throw new Error(`Judge-Artefaktprüfung fehlgeschlagen: ${verification.errors.join("; ")}`);
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
