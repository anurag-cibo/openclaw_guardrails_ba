import { digestObject } from "./fingerprint.mjs";
import { buildRunSummary } from "./run-summary.mjs";
import { readRun } from "./run-state.mjs";

export function buildPilotCompatibility(fingerprints, livePlan, pluginProvenance) {
  const components = fingerprints.components;
  const basis = {
    schemaVersion: 1,
    measurementContractFingerprint: livePlan.measurementContract.fingerprint,
    registries: components.registries,
    adapters: components.adapters,
    control: components.control,
    runtimeAdapters: components.runtimeAdapters,
    runtimeLock: components.runtimeLock,
    models: components.models,
    deployedPluginNormalizedTextSha256: pluginProvenance.deployed.normalizedTextSha256,
    measurementBaselinePluginNormalizedTextSha256:
      pluginProvenance.measurementBaseline.normalizedTextSha256,
  };
  return {
    schemaVersion: 1,
    fingerprint: digestObject(basis),
    measurementContractFingerprint: livePlan.measurementContract.fingerprint,
  };
}

export async function qualifyPilotRun(root, pilotRunId, expectedCompatibility) {
  if (typeof pilotRunId !== "string" || !pilotRunId) {
    throw new Error("Main-Gate: --pilot-run mit einer abgeschlossenen Pilot-Run-ID fehlt");
  }
  const pilot = await readRun(root, pilotRunId);
  if (pilot.status.kind !== "pilot") throw new Error(`Main-Gate: ${pilotRunId} ist kein Pilot`);
  if (pilot.status.state !== "completed") {
    throw new Error(`Main-Gate: Pilot ${pilotRunId} ist nicht abgeschlossen (${pilot.status.state})`);
  }
  const observed = pilot.manifest.metadata?.pilotCompatibility;
  if (!observed?.fingerprint) {
    throw new Error(`Main-Gate: Pilot ${pilotRunId} besitzt noch keinen Kompatibilitaetsfingerprint`);
  }
  if (observed.fingerprint !== expectedCompatibility.fingerprint) {
    throw new Error(
      `Main-Gate: Pilot ${pilotRunId} passt nicht zum Main-Vertrag ` +
      `(erwartet ${expectedCompatibility.fingerprint}, gefunden ${observed.fingerprint})`,
    );
  }
  const summary = await buildRunSummary(root, pilotRunId);
  if (!summary.integrity.ok) throw new Error(`Main-Gate: Artefaktintegritaet des Piloten ${pilotRunId} ist fehlerhaft`);
  if (summary.pilotTechnicalGate.status !== "passed") {
    throw new Error(`Main-Gate: technisches Pilotgate ist ${summary.pilotTechnicalGate.status}`);
  }
  return {
    schemaVersion: 1,
    status: "passed",
    pilotRunId,
    compatibilityFingerprint: expectedCompatibility.fingerprint,
    pilotTechnicalGate: summary.pilotTechnicalGate,
    pilotArtifactsChecked: summary.integrity.checked,
  };
}
