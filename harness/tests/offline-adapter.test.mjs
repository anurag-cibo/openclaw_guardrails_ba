import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runLatencyOffline } from "../src/adapters/latency-offline.mjs";
import { runPolicyOffline } from "../src/adapters/policy-offline.mjs";
import { executeOfflineRun } from "../src/lib/offline-run.mjs";
import { sha256File } from "../src/lib/registry.mjs";
import { verifyRunArtifacts } from "../src/lib/run-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_SOURCE = path.join(ROOT, "vendor/plugin-baseline/src/policy.js");
const HISTORICAL_RUNNER = path.join(ROOT, "runners/run_policy_offline.mjs");

async function temporaryDirectory(t, label = "harness-offline-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), label));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readJsonLines(file) {
  return (await readFile(file, "utf8")).split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}

function stablePolicyProjection(rows) {
  return rows.map(({ duration_ms: _duration, ...row }) => row);
}

const POLICY_CASES = [
  {
    id: "E1", corpus: "corpora/research/policy_corpus.jsonl", cases: 116,
    anchors: { decisionMatches: 116, benign: 39, risky: 77, falsePositiveC1: 21, falseNegativeC1: 0 },
  },
  {
    id: "E2", corpus: "corpora/research/evasion_corpus.jsonl", cases: 36,
    anchors: { decisionMatches: 36, benign: 2, risky: 34, falsePositiveC1: 0, falseNegativeC1: 0 },
  },
  {
    id: "E1ext", corpus: "corpora/research/e1_extension_ruleevasion.jsonl", cases: 35,
    anchors: { decisionMatches: 3, benign: 0, risky: 35, falsePositiveC1: 0, falseNegativeC1: 32 },
  },
];

for (const specification of POLICY_CASES) {
  test(`${specification.id} adapter is field-compatible with the frozen historical runner`, async (t) => {
    const directory = await temporaryDirectory(t, `harness-${specification.id.toLowerCase()}-`);
    const corpusPath = path.join(ROOT, specification.corpus);
    const rawOutput = path.join(directory, "new.jsonl");
    const summaryOutput = path.join(directory, "summary.json");
    const current = await runPolicyOffline({
      experimentId: specification.id,
      corpusPath,
      policySource: POLICY_SOURCE,
      rawOutput,
      summaryOutput,
      expectedCases: specification.cases,
    });
    const historicalOutput = path.join(directory, "historical.jsonl");
    const historical = spawnSync(process.execPath, [HISTORICAL_RUNNER, corpusPath, historicalOutput], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GUARDRAIL_SRC: path.dirname(POLICY_SOURCE) },
    });
    assert.equal(historical.status, 0, historical.stderr);
    assert.deepEqual(
      stablePolicyProjection(current.results),
      stablePolicyProjection(await readJsonLines(historicalOutput)),
    );
    for (const [name, expected] of Object.entries(specification.anchors)) {
      assert.equal(current.summary.counts[name], expected, name);
    }
  });
}

test("E3 adapter uses fresh workers and validates every round", async (t) => {
  const directory = await temporaryDirectory(t, "harness-e3-");
  const result = await runLatencyOffline({
    corpusPath: path.join(ROOT, "corpora/examples/minimal_policy.jsonl"),
    policySource: POLICY_SOURCE,
    rawOutputDirectory: path.join(directory, "raw"),
    summaryOutput: path.join(directory, "summary.json"),
    iterations: 3,
    rounds: 2,
    warmupCalls: 2,
    expectedCases: 2,
  });
  assert.equal(result.outputs.length, 2);
  assert.equal(result.summary.configuration.totalEvaluations, 12);
  assert.equal(result.summary.configuration.freshNodeProcessPerRound, true);
  for (const output of result.outputs) {
    assert.equal(output.data.meta.total_evaluations, 6);
    assert.equal(output.data.overall_self.n, 6);
    assert.equal(output.data.overall_wall.n, 6);
    assert.match(output.sha256, /^[a-f0-9]{64}$/);
  }
});

test("offline pilot is integrated with run state and artifact hashes", async (t) => {
  const stateRoot = await temporaryDirectory(t, "harness-offline-run-");
  const run = await executeOfflineRun(ROOT, {
    kind: "pilot",
    requested: ["E1", "E2"],
    stateRoot,
  });
  assert.equal(run.status.state, "completed");
  assert.deepEqual(run.status.stages.map((stage) => stage.status), ["succeeded", "succeeded"]);
  assert.deepEqual(run.status.stages.map((stage) => stage.artifacts.length), [3, 3]);
  for (const stage of run.status.stages) {
    for (const artifact of stage.artifacts) {
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      assert.equal(
        await sha256File(path.join(run.paths.directory, artifact.path)),
        artifact.sha256,
      );
    }
  }
  assert.deepEqual(await verifyRunArtifacts(stateRoot, run.status.runId), {
    ok: true,
    checked: 6,
    errors: [],
  });
  assert.equal(run.manifest.metadata.offlineOnly, true);
  assert.equal(run.manifest.kind, "pilot");
  const firstArtifact = run.status.stages[0].artifacts[0];
  await appendFile(path.join(run.paths.directory, firstArtifact.path), "{}\n", "utf8");
  const tampered = await verifyRunArtifacts(stateRoot, run.status.runId);
  assert.equal(tampered.ok, false);
  assert.match(tampered.errors[0], /SHA-256 abweichend/);
});
