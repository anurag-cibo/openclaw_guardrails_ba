import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRegistries, treeInventory, validateRegistries, verifyCorpusHashes } from "../src/lib/registry.mjs";
import { makePlan, selectExperiments } from "../src/lib/plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("registries are structurally valid", async () => {
  const registries = await loadRegistries(ROOT);
  assert.deepEqual(await validateRegistries(ROOT, registries), []);
});

test("all copied corpora retain their registered SHA-256", async () => {
  const registries = await loadRegistries(ROOT);
  assert.deepEqual(await verifyCorpusHashes(ROOT, registries), []);
});

test("experiment runner inventory matches its registered baseline", async () => {
  const registries = await loadRegistries(ROOT);
  const expected = registries.snapshots.experimentRunners;
  const actual = await treeInventory(path.join(ROOT, expected.copy));
  assert.equal(actual.files, expected.files);
  assert.equal(actual.sha256, expected.inventorySha256);
});

test("registry contains every experiment ID used by the current thesis", async () => {
  const { experiments } = await loadRegistries(ROOT);
  assert.deepEqual(experiments.canonicalOrder, [
    "E1", "E1ext", "E1aeg", "E2", "E3", "E4", "E4ext",
    "E4abl", "E4aeg", "E5", "E5aeg", "E6a", "E6b", "E7",
  ]);
});

test("pilot plan preserves canonical ordering and pilot parameters", async () => {
  const { experiments } = await loadRegistries(ROOT);
  const selected = selectExperiments(experiments, ["E5aeg", "E1", "E4"]);
  assert.deepEqual(selected, ["E1", "E4", "E5aeg"]);
  const plan = makePlan(experiments, selected, true);
  assert.equal(plan[0].mode, "pilot");
  assert.equal(plan[2].parameters.cases, 6);
});

test("authoritative analysis registry supersedes compute_metrics", async () => {
  const { analysis } = await loadRegistries(ROOT);
  assert.equal(analysis.supersededPipeline.status, "superseded");
  const statuses = new Map(analysis.components.map((item) => [item.id, item.status]));
  assert.equal(statuses.get("core-e1-e7"), "authoritative-core");
  assert.equal(statuses.get("latency-target"), "authoritative-override");
  assert.equal(statuses.get("external-live"), "authoritative-extension");
});

test("golden reference snapshots retain their frozen inventories", async () => {
  const { snapshots } = await loadRegistries(ROOT);
  const expected = {
    core_20260806: snapshots.referenceOutputs.core_20260806,
    e3_haw: snapshots.referenceOutputs.e3_haw,
    e4aeg: snapshots.referenceOutputs.e4aeg,
    e5aeg_archive: snapshots.e5aegArchive,
  };
  for (const [directory, snapshot] of Object.entries(expected)) {
    const actual = await treeInventory(path.join(ROOT, "reference", directory));
    assert.equal(actual.files, snapshot.files, directory);
    assert.equal(actual.sha256, snapshot.inventorySha256, directory);
  }
});

test("E5aeg golden summary contains the values used in the thesis", async () => {
  const file = path.join(
    ROOT,
    "reference/e5aeg_archive/docs/evaluations/e5ext/E5ext_summary.json",
  );
  const summary = JSON.parse(await readFile(file, "utf8"));
  assert.equal(summary.validation.rows, 720);
  assert.deepEqual(
    Object.fromEntries(Object.entries(summary.task_success_by_config).map(([id, value]) => [id, [value.k, value.n]])),
    { C0: [60, 60], C1: [7, 60], C2: [60, 60], C3: [59, 60] },
  );
  assert.equal(summary.primary_c1_to_c2.mcnemar.c1_failure_c2_success, 53);
  assert.equal(summary.primary_c1_to_c2.mcnemar.c1_success_c2_failure, 0);
});

test("E3 HAW golden report contains the target-system mean used in the thesis", async () => {
  const report = await readFile(path.join(ROOT, "reference/e3_haw/E3_haw_report.md"), "utf8");
  assert.match(report, /0\.03592/);
  assert.match(report, /1,740,000/);
});
