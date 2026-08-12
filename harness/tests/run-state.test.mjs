import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digestObject } from "../src/lib/fingerprint.mjs";
import {
  RunLockedError,
  RunStateError,
  createRun,
  isRunLocked,
  listRuns,
  readRun,
  registerRunArtifacts,
  recoverRun,
  runPaths,
  transitionRun,
  transitionStage,
  validateRunId,
} from "../src/lib/run-state.mjs";

const PLAN = [
  { id: "E1", runner: "policy", mode: "pilot", parameters: { cases: 2 } },
  { id: "E4", runner: "judge", mode: "pilot", parameters: { cases: 1 } },
];

function fixedClock() {
  let step = 0;
  return () => new Date(Date.UTC(2026, 7, 10, 12, 0, step++));
}

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-run-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("createRun creates an isolated immutable manifest and mutable status", async (t) => {
  const root = await temporaryRoot(t);
  const created = await createRun(root, {
    kind: "pilot",
    plan: PLAN,
    fingerprints: { environmentFingerprint: "env", executionFingerprint: "exec" },
    runId: "20260810T120000Z_pilot_test01",
    clock: fixedClock(),
  });
  assert.equal(created.status.state, "created");
  assert.equal(created.status.revision, 0);
  assert.match(created.status.manifestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(created.status.stages.map((stage) => stage.status), ["pending", "pending"]);
  for (const directory of [created.paths.logs, created.paths.raw, created.paths.derived, created.paths.inputs]) {
    const info = await import("node:fs/promises").then(({ stat }) => stat(directory));
    assert.equal(info.isDirectory(), true);
  }
  const manifest = JSON.parse(await readFile(created.paths.manifest, "utf8"));
  assert.equal(manifest.immutable, true);
  const events = (await readFile(created.paths.events, "utf8")).trim().split("\n");
  assert.equal(events.length, 1);
});

test("run and stage state transitions enforce ordering and completion", async (t) => {
  const root = await temporaryRoot(t);
  const runId = "20260810T120000Z_pilot_test02";
  const clock = fixedClock();
  await createRun(root, { kind: "pilot", plan: PLAN, fingerprints: {}, runId, clock });
  await transitionRun(root, runId, "preflight", { clock });
  await transitionRun(root, runId, "ready", { clock });
  await transitionRun(root, runId, "running", { clock });

  await assert.rejects(
    transitionStage(root, runId, "E4", "running", { clock }),
    /Vorherige Stufen nicht abgeschlossen/,
  );
  await transitionStage(root, runId, "E1", "running", { clock });
  await transitionStage(root, runId, "E1", "succeeded", { clock });
  await transitionStage(root, runId, "E4", "running", { clock });
  await transitionStage(root, runId, "E4", "succeeded", { clock });
  const completed = await transitionRun(root, runId, "completed", { clock });
  assert.equal(completed.state, "completed");
  assert.equal(completed.revision, 8);
  assert.equal(await isRunLocked(root, runId), false);
});

test("illegal transitions are rejected without changing status revision", async (t) => {
  const root = await temporaryRoot(t);
  const runId = "20260810T120000Z_main_test03";
  await createRun(root, { kind: "main", plan: PLAN, fingerprints: {}, runId, clock: fixedClock() });
  await assert.rejects(transitionRun(root, runId, "completed"), RunStateError);
  const run = await readRun(root, runId);
  assert.equal(run.status.state, "created");
  assert.equal(run.status.revision, 0);
});

test("main analysis registers and verifies run-level derived artifacts", async (t) => {
  const root = await temporaryRoot(t);
  const runId = "20260810T120000Z_main_metrics";
  const clock = fixedClock();
  const created = await createRun(root, { kind: "main", plan: [PLAN[0]], fingerprints: {}, runId, clock });
  await transitionRun(root, runId, "preflight", { clock });
  await transitionRun(root, runId, "ready", { clock });
  await transitionRun(root, runId, "running", { clock });
  await transitionStage(root, runId, "E1", "running", { clock });
  await transitionStage(root, runId, "E1", "succeeded", { clock });
  await transitionRun(root, runId, "analyzing", { clock });
  const file = path.join(created.paths.derived, "metrics.bundle.json");
  const content = "{\"ok\":true}\n";
  await writeFile(file, content, "utf8");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  await registerRunArtifacts(root, runId, [{ role: "run-metrics", path: "derived/metrics.bundle.json", sha256 }], { clock });
  const verified = await import("../src/lib/run-state.mjs").then(({ verifyRunArtifacts }) => verifyRunArtifacts(root, runId));
  assert.deepEqual(verified, { ok: true, checked: 1, errors: [] });
  const completed = await transitionRun(root, runId, "completed", { clock });
  assert.equal(completed.artifacts[0].role, "run-metrics");
});

test("manifest tampering is detected before reads and mutations", async (t) => {
  const root = await temporaryRoot(t);
  const runId = "20260810T120000Z_pilot_test_integrity";
  const created = await createRun(root, {
    kind: "pilot",
    plan: PLAN,
    fingerprints: {},
    runId,
    clock: fixedClock(),
  });
  const manifest = JSON.parse(await readFile(created.paths.manifest, "utf8"));
  manifest.metadata = { tampered: true };
  await writeFile(created.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await assert.rejects(readRun(root, runId), /Manifest-Integritätsprüfung fehlgeschlagen/);
  await assert.rejects(transitionRun(root, runId, "preflight"), /Manifest-Integritätsprüfung fehlgeschlagen/);
  assert.equal(await isRunLocked(root, runId), false);
});

test("a failed stage fails the run and recovery resets only incomplete work", async (t) => {
  const root = await temporaryRoot(t);
  const runId = "20260810T120000Z_pilot_test04";
  const clock = fixedClock();
  await createRun(root, { kind: "pilot", plan: PLAN, fingerprints: {}, runId, clock });
  await transitionRun(root, runId, "preflight", { clock });
  await transitionRun(root, runId, "ready", { clock });
  await transitionRun(root, runId, "running", { clock });
  await transitionStage(root, runId, "E1", "running", { clock });
  await transitionStage(root, runId, "E1", "succeeded", { clock });
  await transitionStage(root, runId, "E4", "running", { clock });
  const failed = await transitionStage(root, runId, "E4", "failed", { error: "timeout", clock });
  assert.equal(failed.state, "failed");
  const recovered = await recoverRun(root, runId, { clock });
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.resumeCount, 1);
  assert.deepEqual(recovered.stages.map((stage) => stage.status), ["succeeded", "pending"]);
  assert.deepEqual(recovered.stages.map((stage) => stage.attempts), [1, 1]);
});

test("an existing lock prevents concurrent mutation", async (t) => {
  const root = await temporaryRoot(t);
  const runId = "20260810T120000Z_pilot_test05";
  await createRun(root, { kind: "pilot", plan: PLAN, fingerprints: {}, runId, clock: fixedClock() });
  const paths = runPaths(root, runId);
  await writeFile(paths.lock, "{}\n", "utf8");
  await assert.rejects(transitionRun(root, runId, "preflight"), RunLockedError);
});

test("listRuns reports valid and corrupt run directories", async (t) => {
  const root = await temporaryRoot(t);
  await createRun(root, {
    kind: "pilot",
    plan: PLAN,
    fingerprints: {},
    runId: "20260810T120000Z_pilot_test06",
    clock: fixedClock(),
  });
  await mkdir(path.join(root, "artifacts/runs/broken-run"), { recursive: true });
  const runs = await listRuns(root);
  assert.deepEqual(runs.map((run) => run.state), ["created", "corrupt"]);
});

test("fingerprint input serialization is key-order independent", () => {
  assert.equal(digestObject({ b: 2, a: { y: 2, x: 1 } }), digestObject({ a: { x: 1, y: 2 }, b: 2 }));
  assert.notEqual(digestObject({ cases: 1 }), digestObject({ cases: 2 }));
});

test("run IDs reject path traversal", () => {
  assert.throws(() => validateRunId("../escape"), RunStateError);
  assert.throws(() => validateRunId("a/b"), RunStateError);
});
