import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./json.mjs";
import { sha256File } from "./registry.mjs";

const SOURCES = Object.freeze({
  core: "reference/core_20260806/metriken.json",
  latencyTarget: "reference/e3_haw/E3_haw_summary.json",
  externalPolicy: "reference/e4aeg/E8_1_aegish_policy_summary.json",
  externalJudge: "reference/e4aeg/E8_2_aegish_judge_summary.json",
  externalLive: "reference/e5aeg_archive/docs/evaluations/e5ext/E5ext_summary.json",
});

async function loadSource(root, id, relativePath) {
  const absolute = path.join(root, relativePath);
  return {
    id,
    relativePath,
    sha256: await sha256File(absolute),
    value: JSON.parse(await readFile(absolute, "utf8")),
  };
}

function invariant(condition, message) {
  if (!condition) throw new Error(`Metrik-Referenzanker verletzt: ${message}`);
}

function validateAnchors({ core, latencyTarget, externalPolicy, externalJudge, externalLive }) {
  invariant(core.e4.aufrufe === 390 && core.e4.faelle === 78, "E4 muss 390 Aufrufe/78 Fälle enthalten");
  invariant(core.live_balanciert.C0.laeufe === 130 && core.live_balanciert.C3.laeufe === 130, "E5-Balancierung muss 130 je Konfiguration enthalten");
  invariant(core.approval_e6a.laeufe === 20 && core.approval_e6b.laeufe === 290, "E6a/E6b-Nenner müssen 20/290 sein");
  invariant(latencyTarget.validation.evaluations_total === 1740000, "E3-HAW muss 1.740.000 Auswertungen enthalten");
  invariant(Math.abs(latencyTarget.aggregate.overall_self.pooled_mean_ms - 0.03592) < 1e-12, "E3-HAW-Mittelwert muss 0,03592 ms sein");
  invariant(externalPolicy.policy_action_view.n === 1172, "E1aeg muss 1.172 Befehle enthalten");
  invariant(externalJudge.validation.judge_rows === 3459 && externalJudge.validation.unique_judge_cases === 1113, "E4aeg muss 3.459 Aufrufe/1.113 Fälle enthalten");
  invariant(externalLive.validation.rows === 720 && externalLive.validation.matrix_complete === true, "E5aeg muss eine vollständige 720er-Matrix enthalten");
  const expectedSuccesses = { C0: 60, C1: 7, C2: 60, C3: 59 };
  for (const [config, successes] of Object.entries(expectedSuccesses)) {
    invariant(externalLive.task_success_by_config[config].k === successes, `E5aeg ${config} muss k=${successes} enthalten`);
    invariant(externalLive.task_success_by_config[config].n === 60, `E5aeg ${config} muss n=60 enthalten`);
  }
  invariant(externalLive.primary_c1_to_c2.mcnemar.c1_failure_c2_success === 53, "E5aeg McNemar muss 53 Gewinne enthalten");
  invariant(externalLive.primary_c1_to_c2.mcnemar.c1_success_c2_failure === 0, "E5aeg McNemar muss 0 Verluste enthalten");
}

function sourceDescriptor(source, role, experiments, status) {
  return {
    role,
    experiments,
    status,
    path: source.relativePath,
    sha256: source.sha256,
  };
}

export async function buildReferenceMetricsBundle(root) {
  const loaded = await Promise.all(Object.entries(SOURCES).map(([id, relativePath]) => loadSource(root, id, relativePath)));
  const sources = Object.fromEntries(loaded.map((source) => [source.id, source]));
  const values = Object.fromEntries(loaded.map((source) => [source.id, source.value]));
  validateAnchors(values);

  const canonicalCore = structuredClone(values.core);
  const supersededWindowsLatency = canonicalCore.e3_latenz;
  canonicalCore.e3_latenz = {
    experimentId: "E3",
    variant: "haw_target_replication",
    aggregationLevel: "evaluation and independent round",
    evaluations: values.latencyTarget.validation.evaluations_total,
    rounds: values.latencyTarget.validation.rounds,
    overall_self: values.latencyTarget.aggregate.overall_self,
    overall_wall: values.latencyTarget.aggregate.overall_wall,
    sourcePath: sources.latencyTarget.relativePath,
    sourceSha256: sources.latencyTarget.sha256,
    overrides: "reference/core_20260806/metriken.json:e3_latenz (Windows)",
  };

  return {
    schemaVersion: 1,
    bundleId: "ba-reference-20260810",
    bundleKind: "frozen-authoritative-reference",
    finalEligibility: {
      eligibleAsHistoricalReference: true,
      eligibleAsNewHarnessMainRun: false,
      reason: "Golden-Merge bestehender autoritativer Hauptauswertungen; keine neue Harness-Run-ID.",
    },
    provenance: {
      sourceSearchUsed: false,
      sources: {
        core: sourceDescriptor(sources.core, "authoritative core", ["E1", "E1ext", "E2", "E3", "E4", "E4ext", "E4abl", "E5", "E6a", "E6b", "E7"], "main-reference"),
        latencyTarget: sourceDescriptor(sources.latencyTarget, "authoritative target-system override", ["E3"], "main-reference"),
        externalPolicy: sourceDescriptor(sources.externalPolicy, "authoritative external policy", ["E1aeg"], "main-reference"),
        externalJudge: sourceDescriptor(sources.externalJudge, "authoritative external judge", ["E4aeg"], "main-reference"),
        externalLive: sourceDescriptor(sources.externalLive, "authoritative external live", ["E5aeg"], "main-reference"),
      },
    },
    components: {
      core: {
        experimentIds: ["E1", "E1ext", "E2", "E3", "E4", "E4ext", "E4abl", "E5", "E6a", "E6b", "E7"],
        measurementStatus: "historical-main-reference-with-e3-haw-override",
        metrics: canonicalCore,
      },
      externalPolicy: { experimentIds: ["E1aeg"], measurementStatus: "historical-main-reference", metrics: values.externalPolicy },
      externalJudge: { experimentIds: ["E4aeg"], measurementStatus: "historical-main-reference", metrics: values.externalJudge },
      externalLive: { experimentIds: ["E5aeg"], measurementStatus: "historical-main-reference", metrics: values.externalLive },
    },
    superseded: {
      e3Windows: {
        reason: "Durch spätere Messung auf dem HAW-Zielsystem ersetzt.",
        metrics: supersededWindowsLatency,
      },
    },
    anchors: {
      e4: { calls: 390, cases: 78 },
      e5Balanced: { rowsPerConfig: 130, configs: 4 },
      e6: { E6a: 20, E6b: 290 },
      e3Haw: { evaluations: 1740000, pooledMeanMs: 0.03592 },
      e1aeg: { commands: 1172 },
      e4aeg: { calls: 3459, cases: 1113 },
      e5aeg: { rows: 720, successes: { C0: 60, C1: 7, C2: 60, C3: 59 }, mcnemarWins: 53, mcnemarLosses: 0 },
    },
    validation: {
      anchorsPassed: true,
      sourceHashesPresent: true,
      pilotOrMockInputAccepted: false,
    },
  };
}

export async function writeReferenceMetricsBundle(root, output) {
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const bundle = await buildReferenceMetricsBundle(root);
  await atomicWriteJson(resolved, bundle);
  return { output: resolved, sha256: await sha256File(resolved), bundle };
}
