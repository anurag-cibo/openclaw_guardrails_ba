import path from "node:path";
import { loadApprovalCorpus, loadLiveCorpus } from "./live-corpus.mjs";
import { loadLiveProfile } from "./live-profile.mjs";
import { digestObject } from "./fingerprint.mjs";
import { loadRegistries, validateRegistries, verifyCorpusHashes } from "./registry.mjs";

export const LIVE_EXPERIMENTS = Object.freeze(["E5", "E6a", "E6b"]);
const LIVE_SET = new Set(LIVE_EXPERIMENTS);
const E5_PILOT_CASES = Object.freeze(["L-DB-01", "L-DB-04", "L-DR-01", "L-DR-02"]);
const E5_DEPTH_CASES = Object.freeze(["L-SR-02", "L-INJ-03"]);
const PUBLIC_PILOT_CORPORA = Object.freeze({
  live: Object.freeze({ root: "harness", path: "corpora/pilot/live.jsonl", cases: 4 }),
  approval: Object.freeze({ root: "harness", path: "corpora/pilot/approval.jsonl", cases: 5 }),
});

function phase({ id, script, expectedRows, environment, note, maxAttempts = 1, retryDelayMs = 0 }) {
  return { id, script, expectedRows, environment, note, maxAttempts, retryDelayMs };
}

function retryContract(retry, fallbackAttempts = 1) {
  return {
    maxAttempts: retry?.phaseAttempts ?? fallbackAttempts,
    retryDelayMs: retry?.phaseDelayMs ?? (fallbackAttempts > 1 ? 12_000 : 0),
  };
}

function readinessEnvironment(retry) {
  if (!retry) return {};
  return {
    GATEWAY_READY_ATTEMPTS: String(retry.gatewayAttempts),
    GATEWAY_READY_INTERVAL_SECONDS: String(retry.gatewayIntervalSeconds),
    GATEWAY_READY_TIMEOUT_SECONDS: String(retry.gatewayTimeoutSeconds),
    GATEWAY_PREFLIGHT_ATTEMPTS: String(retry.toolPreflightAttempts),
  };
}

function e5Plan(kind, liveCases, corpusPath, settings = null, retry = null) {
  const allIds = new Set(liveCases.map((row) => row.id));
  const pilotCases = settings?.caseIds ?? E5_PILOT_CASES;
  const requiredIds = settings ? pilotCases : (kind === "pilot" ? pilotCases : [...E5_PILOT_CASES, ...E5_DEPTH_CASES]);
  for (const id of requiredIds) {
    if (!allIds.has(id)) throw new Error(`E5-Plan referenziert fehlenden Korpusfall ${id}`);
  }
  if (settings || kind === "pilot") {
    const configs = settings?.configs ?? ["C0", "C1", "C2", "C3"];
    const reps = settings?.reps ?? 1;
    const expectedRows = configs.length * pilotCases.length * reps;
    return {
      expectedRows,
      phases: [phase({
        id: kind === "pilot" ? "pilot-stratified" : "profile-main-matrix",
        script: "adapters/live/run_e5.sh",
        expectedRows,
        environment: {
          CORPUS: corpusPath,
          CONFIGS: configs.join(" "),
          CASE_IDS: pilotCases.join(" "),
          REPS: String(reps),
          C3_APPROVAL_POLICY: settings?.c3ApprovalPolicy ?? "deny",
          E5_APPEND: "0",
          ...readinessEnvironment(retry),
        },
        note: `${pilotCases.length} Profilfälle über ${configs.length} Konfigurationen mit ${reps} Wiederholung(en)`,
        ...retryContract(retry, 1),
      })],
    };
  }
  const balanced = liveCases.length * 4 * 5;
  const depth = E5_DEPTH_CASES.length * 2 * 15;
  if (balanced !== 520 || depth !== 60) throw new Error(`E5-Matrix unerwartet: ${balanced}+${depth}`);
  return {
    expectedRows: balanced + depth,
    balancedRows: balanced,
    phases: [
      phase({
        id: "balanced-core",
        script: "adapters/live/run_e5.sh",
        expectedRows: balanced,
        environment: { CORPUS: corpusPath, CONFIGS: "C0 C1 C2 C3", CASE_IDS: "", REPS: "5", E5_APPEND: "0" },
        note: "26 Fälle × 4 Konfigurationen × 5 Wiederholungen",
      }),
      phase({
        id: "judge-depth",
        script: "adapters/live/run_e5.sh",
        expectedRows: depth,
        environment: {
          CORPUS: corpusPath,
          CONFIGS: "C2 C3",
          CASE_IDS: E5_DEPTH_CASES.join(" "),
          REPS: "15",
          E5_APPEND: "1",
        },
        note: "Zwei Judge-relevante Fälle × C2/C3 × 15 Zusatzwiederholungen",
      }),
    ],
  };
}

function e6aPlan(kind, corpusPath, settings = null, retry = null) {
  const repetitions = settings?.reps ?? (kind === "pilot" ? 1 : 5);
  const arms = settings?.arms ?? ["deny", "allow-once", "timeout"];
  const c2Reps = settings?.c2Reps ?? repetitions;
  const expectedRows = repetitions * arms.length + c2Reps;
  return {
    expectedRows,
    phases: [phase({
      id: kind === "pilot" ? "pilot-lifecycle" : "lifecycle-matrix",
      script: "adapters/live/run_e6.sh",
      expectedRows,
      environment: {
        CORPUS: corpusPath,
        E6_CASE_ID: settings?.caseId ?? "L-DR-02",
        E6_ARMS: arms.join(" "),
        E6_REPS: String(repetitions),
        E6_C2_REPS: String(c2Reps),
        ...readinessEnvironment(retry),
      },
      note: `${arms.length} C3-Arme plus ${c2Reps} C2-Kontrollläufe`,
      ...retryContract(retry, 3),
    })],
  };
}

function e6bPlan(kind, approvalCases, corpusPath, settings = null, retry = null) {
  const selected = settings
    ? settings.caseIds.map((id) => approvalCases.find((row) => row.id === id)).filter(Boolean)
    : approvalCases.filter((row) => row.in_default_matrix);
  if (settings && selected.length !== settings.caseIds.length) {
    const found = new Set(selected.map((row) => row.id));
    throw new Error(`E6b-Profil referenziert fehlende Fälle: ${settings.caseIds.filter((id) => !found.has(id)).join(", ")}`);
  }
  const allowedArms = settings?.arms ?? null;
  const armsFor = (row) => allowedArms ? row.arms.filter((arm) => allowedArms.includes(arm)) : row.arms;
  for (const row of selected) {
    if (!armsFor(row).length) throw new Error(`E6b-Profil wählt für ${row.id} keinen im Korpus erlaubten Arm`);
  }
  if (settings?.c2Reps > 0 && !settings.caseIds.includes(settings.c2CaseId)) {
    throw new Error(`E6b-Profil: C2-Kontrollfall ${settings.c2CaseId} fehlt in caseIds`);
  }
  const c3Rows = selected.reduce((total, row) => {
    const reps = settings?.reps ?? (kind === "pilot" ? 1 : row.reps);
    return total + armsFor(row).length * reps;
  }, 0);
  const expectedRows = c3Rows + (settings?.c2Reps ?? 0);
  return {
    expectedRows,
    phases: [phase({
      id: kind === "pilot" ? "pilot-core-exec" : "core-exec-matrix",
      script: "adapters/live/run_e6b.sh",
      expectedRows,
      environment: {
        CORPUS: corpusPath,
        E6B_CASE_IDS: selected.map((row) => row.id).join(" "),
        E6B_ARMS: allowedArms?.join(" ") ?? "",
        E6B_REPS_OVERRIDE: settings ? String(settings.reps) : (kind === "pilot" ? "1" : ""),
        E6B_C2_REPS: String(settings?.c2Reps ?? 0),
        E6B_C2_CASE_ID: settings?.c2CaseId ?? "E6B-01",
        E6B_APPEND: "0",
        ...readinessEnvironment(retry),
      },
      note: `${selected.length} Profilfälle, ${c3Rows} C3- und ${settings?.c2Reps ?? 0} C2-Läufe`,
      ...retryContract(retry, 3),
    })],
  };
}

export async function makeLivePlan(root, { kind, requested = [], profilePath = null } = {}) {
  const profile = profilePath ? await loadLiveProfile(root, profilePath) : null;
  const resolvedKind = profile?.kind ?? kind;
  if (!new Set(["pilot", "main"]).has(resolvedKind)) throw new Error("Live-Plan erwartet 'pilot' oder 'main'");
  if (profile && kind && kind !== profile.kind) throw new Error(`Profilart ${profile.kind} widerspricht angeforderter Art ${kind}`);
  const registries = await loadRegistries(root);
  const errors = await validateRegistries(root, registries);
  errors.push(...await verifyCorpusHashes(root, registries));
  if (errors.length) throw new Error(`Live-Plan-Preflight fehlgeschlagen: ${errors.join("; ")}`);

  const selected = requested.length ? requested : (profile?.experiments ?? [...LIVE_EXPERIMENTS]);
  const unknown = selected.filter((id) => !LIVE_SET.has(id));
  if (unknown.length) throw new Error(`Keine Live-/Approval-Freigabe für: ${unknown.join(", ")}`);
  if (new Set(selected).size !== selected.length) throw new Error("Live-Auswahl enthält Duplikate");

  const liveRegistry = profile?.corpora.live ?? (resolvedKind === "pilot" ? PUBLIC_PILOT_CORPORA.live : registries.corpora.corpora.live);
  const approvalRegistry = profile?.corpora.approval ?? (resolvedKind === "pilot" ? PUBLIC_PILOT_CORPORA.approval : registries.corpora.corpora.approval);
  const [live, approval] = await Promise.all([
    loadLiveCorpus(liveRegistry.readPath ?? path.join(root, liveRegistry.path), { expectedCases: liveRegistry.cases }),
    loadApprovalCorpus(approvalRegistry.readPath ?? path.join(root, approvalRegistry.path), { expectedCases: approvalRegistry.cases }),
  ]);
  const builders = {
    E5: () => e5Plan(resolvedKind, live.cases, liveRegistry.path, profile?.matrix.E5, profile?.retry),
    E6a: () => e6aPlan(resolvedKind, liveRegistry.path, profile?.matrix.E6a, profile?.retry),
    E6b: () => e6bPlan(resolvedKind, approval.cases, approvalRegistry.path, profile?.matrix.E6b, profile?.retry),
  };
  const stages = selected.map((id, index) => ({
    order: index + 1,
    id,
    runner: registries.experiments.experiments[id].runner,
    mode: resolvedKind,
    corpus: registries.experiments.experiments[id].corpus,
    ...builders[id](),
  }));
  const expectedRows = stages.reduce((total, stage) => total + stage.expectedRows, 0);
  const measurementContractBasis = {
    schemaVersion: 1,
    experiments: stages.map((stage) => stage.id),
    models: profile?.models ?? null,
    corpora: {
      live: { cases: live.cases.length, sha256: live.sha256 },
      approval: { cases: approval.cases.length, sha256: approval.sha256 },
    },
    stages: stages.map((stage) => ({
      id: stage.id,
      runner: stage.runner,
      corpus: stage.corpus,
      expectedRows: stage.expectedRows,
      phases: stage.phases.map((item) => ({
        script: item.script,
        expectedRows: item.expectedRows,
        environment: item.environment,
        maxAttempts: item.maxAttempts,
        retryDelayMs: item.retryDelayMs,
      })),
    })),
    expectedRows,
  };
  return {
    schemaVersion: 1,
    kind: resolvedKind,
    profile: profile ? { name: profile.name, path: profile.sourceRelative, sha256: profile.sha256 } : null,
    models: profile?.models ?? null,
    executionBoundary: "host-runner-docker-socket",
    warning: "Live-Ausführung verändert die OpenClaw-Konfiguration; Docker-Socket-Zugriff entspricht Host-Rechten.",
    corpora: {
      live: { root: liveRegistry.root ?? "harness", path: liveRegistry.path, cases: live.cases.length, sha256: live.sha256 },
      approval: { root: approvalRegistry.root ?? "harness", path: approvalRegistry.path, cases: approval.cases.length, sha256: approval.sha256 },
    },
    stages,
    expectedRows,
    measurementContract: {
      schemaVersion: 1,
      fingerprint: digestObject(measurementContractBasis),
      experiments: measurementContractBasis.experiments,
      expectedRows,
    },
  };
}
