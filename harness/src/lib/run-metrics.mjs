import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./json.mjs";
import { sha256File } from "./registry.mjs";
import { buildRunSummary } from "./run-summary.mjs";
import { readRun } from "./run-state.mjs";

const METRIC_CONTRACT = Object.freeze({
  rateEncoding: "k, n, unit, rate and Wilson 95% interval; null when n=0",
  latencyEncoding: "available, missing, mean, min, p50, p95 and max in milliseconds",
  tokenEncoding: "available, missing, sum, mean, min, p50, p95 and max; unavailable telemetry remains null",
  e5: [
    "toolCallRate", "modelRefusalProxyRate", "systemFailureRate",
    "semanticModelCallRate", "deterministicEscalationRate",
    "interventionRateRisk", "enforcementRateReachedRisk",
    "bypassRateHarmCapable", "harmPreventionRate", "falsePositiveRate",
    "frictionlessExecutionRate", "taskSuccessRate", "approvalLoad",
  ],
  e6: [
    "reachRate", "refusalRate", "validRate", "conditionalFidelity",
    "approvalLoad", "semanticModelCallRate",
  ],
  telemetry: [
    "deterministicPerToolCall", "guardrailPerToolCall",
    "judgePerSemanticCall", "endToEnd", "approvalPerRequest",
    "inputTokens", "outputTokens", "totalTokens",
  ],
});

export async function buildMainRunMetricsBundle(root, runId) {
  const run = await readRun(root, runId);
  if (run.status.kind !== "main") throw new Error(`Run-Metriken: ${runId} ist kein Main-Lauf`);
  if (!new Set(["analyzing", "completed"]).has(run.status.state)) {
    throw new Error(`Run-Metriken: ${runId} ist noch nicht auswertbar (${run.status.state})`);
  }
  if (run.status.stages.some((stage) => stage.status !== "succeeded")) {
    throw new Error(`Run-Metriken: nicht alle Stufen von ${runId} sind erfolgreich`);
  }
  if (run.manifest.metadata?.pilotQualification?.status !== "passed") {
    throw new Error(`Run-Metriken: Pilotqualifikation von ${runId} fehlt`);
  }
  const summary = await buildRunSummary(root, runId);
  if (!summary.integrity.ok) throw new Error(`Run-Metriken: Artefaktintegritaet von ${runId} ist fehlerhaft`);
  const observedRows = summary.stages.reduce((total, stage) => total + (stage.total ?? 0), 0);
  const expectedRows = run.manifest.metadata.expectedRows;
  if (observedRows !== expectedRows) {
    throw new Error(`Run-Metriken: ${observedRows} Ergebniszeilen, erwartet ${expectedRows}`);
  }
  const inputSnapshots = (run.status.artifacts ?? [])
    .filter((artifact) => artifact.role?.startsWith("input-"))
    .map(({ role, path: artifactPath, sha256 }) => ({ role, path: artifactPath, sha256 }));
  const expectedInputRoles = ["input-profile", "input-corpus-live", "input-corpus-approval"];
  const missingInputRoles = expectedInputRoles.filter((role) => !inputSnapshots.some((item) => item.role === role));
  if (missingInputRoles.length) {
    throw new Error(`Run-Metriken: Eingabe-Snapshots fehlen: ${missingInputRoles.join(", ")}`);
  }
  return {
    schemaVersion: 2,
    bundleKind: "profile-defined-main-run",
    runId,
    generatedFromState: run.status.state,
    finalEligibility: {
      eligibleAsNewHarnessMainRun: true,
      scope: "metrics apply exactly to the declared profile and corpora",
      statisticallyRepresentative: false,
      reason: "Vollstaendiger profildefinierter Main-Lauf nach passendem technischen Pilot; kleines Beispielprofil ohne statistischen Repraesentativitaetsanspruch.",
    },
    scope: {
      profile: run.manifest.metadata.profile,
      experiments: run.manifest.plan.map((stage) => stage.id),
      expectedRows,
      observedRows,
      measurementContract: run.manifest.metadata.measurementContract,
      metricContract: METRIC_CONTRACT,
    },
    provenance: {
      runId,
      pilotRunId: run.manifest.metadata.pilotQualification.pilotRunId,
      pilotCompatibility: run.manifest.metadata.pilotCompatibility,
      environmentFingerprint: run.manifest.fingerprints.environmentFingerprint,
      executionFingerprint: run.manifest.fingerprints.executionFingerprint,
      plugin: run.manifest.metadata.pluginProvenance,
      inputSnapshots,
    },
    metrics: { stages: summary.stages },
    validation: {
      runArtifactsCheckedBeforeBundle: summary.integrity.checked,
      runArtifactsValid: true,
      allStagesSucceeded: true,
      rowCountMatched: true,
      pilotGatePassed: true,
      mockInputAccepted: false,
      pilotInputUsedAsMainMetrics: false,
      inputSnapshotsRegistered: true,
    },
  };
}

export async function writeMainRunMetricsBundle(root, runId, output) {
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const bundle = await buildMainRunMetricsBundle(root, runId);
  await atomicWriteJson(resolved, bundle);
  return { output: resolved, sha256: await sha256File(resolved), bundle };
}
