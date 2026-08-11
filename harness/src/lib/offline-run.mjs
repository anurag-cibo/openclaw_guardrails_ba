import path from "node:path";
import { runLatencyOffline } from "../adapters/latency-offline.mjs";
import { runPolicyOffline } from "../adapters/policy-offline.mjs";
import { loadPolicyCorpus } from "./corpus.mjs";
import { buildFingerprints } from "./fingerprint.mjs";
import { atomicWriteText } from "./json.mjs";
import { makePlan, selectExperiments } from "./plan.mjs";
import { loadRegistries, sha256File, validateRegistries, verifyCorpusHashes } from "./registry.mjs";
import {
  createRun,
  readRun,
  transitionRun,
  transitionStage,
  verifyRunArtifacts,
} from "./run-state.mjs";

export const OFFLINE_EXPERIMENTS = Object.freeze(["E1", "E1ext", "E2", "E3"]);
const OFFLINE_SET = new Set(OFFLINE_EXPERIMENTS);

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

async function executePolicyStage({ codeRoot, run, stage, registries, kind }) {
  const experiment = registries.experiments.experiments[stage.id];
  const corpus = registries.corpora.corpora[experiment.corpus];
  const corpusPath = path.join(codeRoot, corpus.path);
  const rawOutput = path.join(run.paths.raw, stage.id, "results.jsonl");
  const summaryOutput = path.join(run.paths.derived, stage.id, "summary.json");
  const result = await runPolicyOffline({
    experimentId: stage.id,
    corpusPath,
    policySource: path.join(codeRoot, "vendor", "plugin-baseline", "src", "policy.js"),
    rawOutput,
    summaryOutput,
    expectedCases: corpus.cases,
    caseLimit: kind === "pilot" ? stage.parameters.cases : null,
    corpusReference: corpus.path,
    rawReference: relativeToRun(run.paths.directory, rawOutput),
  });
  const logOutput = path.join(run.paths.logs, `${stage.id}.log`);
  await atomicWriteText(logOutput, [
    `adapter=policy-offline`,
    `corpus_sha256=${result.corpus.sha256}`,
    `cases_total=${result.corpus.cases.length}`,
    `cases_selected=${result.selected.length}`,
    `decision_matches=${result.summary.counts.decisionMatches}`,
    `false_positive_c1=${result.summary.counts.falsePositiveC1}`,
    `false_negative_c1=${result.summary.counts.falseNegativeC1}`,
    "",
  ].join("\n"));
  return [
    await artifact(run.paths.directory, "raw-results", rawOutput, { rows: result.results.length }),
    await artifact(run.paths.directory, "stage-summary", summaryOutput),
    await artifact(run.paths.directory, "stage-log", logOutput),
  ];
}

async function executeLatencyStage({ codeRoot, run, stage, registries }) {
  const experiment = registries.experiments.experiments[stage.id];
  const corpus = registries.corpora.corpora[experiment.corpus];
  const summaryOutput = path.join(run.paths.derived, stage.id, "summary.json");
  const result = await runLatencyOffline({
    experimentId: stage.id,
    corpusPath: path.join(codeRoot, corpus.path),
    policySource: path.join(codeRoot, "vendor", "plugin-baseline", "src", "policy.js"),
    rawOutputDirectory: path.join(run.paths.raw, stage.id),
    summaryOutput,
    iterations: stage.parameters.iterations,
    rounds: stage.parameters.rounds,
    warmupCalls: stage.parameters.warmupCalls,
    expectedCases: corpus.cases,
  });
  const logOutput = path.join(run.paths.logs, `${stage.id}.log`);
  await atomicWriteText(logOutput, `${result.logs.join("\n\n")}\n`);
  const artifacts = [];
  for (const output of result.outputs) {
    artifacts.push(await artifact(run.paths.directory, "latency-round", output.outputPath, {
      round: output.data.meta.round,
      evaluations: output.data.meta.total_evaluations,
    }));
  }
  artifacts.push(await artifact(run.paths.directory, "stage-summary", summaryOutput));
  artifacts.push(await artifact(run.paths.directory, "stage-log", logOutput));
  return artifacts;
}

export async function executeOfflineRun(codeRoot, {
  kind,
  requested = [],
  stateRoot = codeRoot,
  clock = () => new Date(),
} = {}) {
  if (!new Set(["pilot", "main"]).has(kind)) throw new Error("Offline-Run erwartet 'pilot' oder 'main'");
  const registries = await loadRegistries(codeRoot);
  const errors = await validateRegistries(codeRoot, registries);
  errors.push(...await verifyCorpusHashes(codeRoot, registries));
  if (errors.length) throw new Error(`Offline-Preflight fehlgeschlagen: ${errors.join("; ")}`);

  const defaultSelection = ["E1", "E2", "E3"];
  const selected = selectExperiments(registries.experiments, requested.length ? requested : defaultSelection);
  const unsupported = selected.filter((id) => !OFFLINE_SET.has(id));
  if (unsupported.length) throw new Error(`Keine Offline-Adapterfreigabe für: ${unsupported.join(", ")}`);
  for (const id of selected) {
    const experiment = registries.experiments.experiments[id];
    const corpus = registries.corpora.corpora[experiment.corpus];
    await loadPolicyCorpus(path.join(codeRoot, corpus.path), { expectedCases: corpus.cases });
  }
  const plan = makePlan(registries.experiments, selected, kind === "pilot");
  const fingerprints = await buildFingerprints(codeRoot, registries, plan, kind, {
    configuration: { executionBoundary: "offline-no-network" },
  });
  const run = await createRun(stateRoot, {
    kind,
    plan,
    fingerprints,
    metadata: { offlineOnly: true, preparedOnly: false },
    clock,
  });

  try {
    await transitionRun(stateRoot, run.manifest.runId, "preflight", { clock });
    await transitionRun(stateRoot, run.manifest.runId, "ready", { clock });
    await transitionRun(stateRoot, run.manifest.runId, "running", { clock });
    for (const stage of plan) {
      await transitionStage(stateRoot, run.manifest.runId, stage.id, "running", { clock });
      try {
        const artifacts = stage.runner === "latency"
          ? await executeLatencyStage({ codeRoot, run, stage, registries })
          : await executePolicyStage({ codeRoot, run, stage, registries, kind });
        await transitionStage(stateRoot, run.manifest.runId, stage.id, "succeeded", {
          artifacts,
          note: `${artifacts.length} Artefakte mit SHA-256 registriert`,
          clock,
        });
      } catch (error) {
        await transitionStage(stateRoot, run.manifest.runId, stage.id, "failed", {
          error: error.message,
          clock,
        });
        throw error;
      }
    }
    const verification = await verifyRunArtifacts(stateRoot, run.manifest.runId);
    if (!verification.ok) {
      throw new Error(`Artefaktprüfung fehlgeschlagen: ${verification.errors.join("; ")}`);
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
