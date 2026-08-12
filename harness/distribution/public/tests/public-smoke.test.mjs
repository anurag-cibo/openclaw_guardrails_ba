import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeJudgeRun } from "../src/lib/judge-run.mjs";
import { makeLivePlan } from "../src/lib/live-plan.mjs";
import { executeOfflineRun } from "../src/lib/offline-run.mjs";
import { loadRegistries, treeInventory, validateRegistries, verifyCorpusHashes } from "../src/lib/registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function names(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...await names(root, absolute));
    else result.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return result;
}

test("public candidate is self-consistent and contains no internal data roots", async () => {
  const registries = await loadRegistries(ROOT);
  assert.deepEqual(await validateRegistries(ROOT, registries), []);
  assert.deepEqual(await verifyCorpusHashes(ROOT, registries), []);
  const inventory = await treeInventory(path.join(ROOT, registries.snapshots.experimentRunners.copy));
  assert.equal(inventory.files, registries.snapshots.experimentRunners.files);
  assert.equal(inventory.sha256, registries.snapshots.experimentRunners.inventorySha256);
  const files = await names(ROOT);
  for (const forbidden of ["reference/", "corpora/private/", "corpora/custom/", "runtime/images/", "runtime/packages/", "TEMP_KAPITEL4_NOTIZEN.md"]) {
    assert.equal(files.some((file) => file === forbidden || file.startsWith(forbidden)), false, forbidden);
  }
});

test("public smoke profile plans exactly four live rows", async () => {
  const plan = await makeLivePlan(ROOT, { profilePath: "profiles/live-smoke.example.json" });
  assert.deepEqual(plan.stages.map((stage) => stage.id), ["E6a"]);
  assert.equal(plan.expectedRows, 4);
});

test("public pilot and main profiles define the same compact 20-row measurement", async () => {
  const pilot = await makeLivePlan(ROOT, { profilePath: "profiles/live-main-pilot.example.json" });
  const main = await makeLivePlan(ROOT, { profilePath: "profiles/live-main.example.json" });
  assert.equal(pilot.kind, "pilot");
  assert.equal(main.kind, "main");
  assert.equal(pilot.expectedRows, 20);
  assert.equal(main.expectedRows, 20);
  assert.deepEqual(main.stages.map((stage) => stage.id), ["E5", "E6a"]);
  assert.equal(pilot.measurementContract.fingerprint, main.measurementContract.fingerprint);
});

test("public offline pilot and mock judge run from the clean package", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "guardrail-public-smoke-"));
  try {
    const offline = await executeOfflineRun(ROOT, { kind: "pilot", requested: ["E1", "E2", "E3"], stateRoot });
    assert.equal(offline.status.state, "completed");
    const judge = await executeJudgeRun(ROOT, { kind: "pilot", requested: ["E4"], stateRoot, mock: true });
    assert.equal(judge.status.state, "completed");
    const manifest = JSON.parse(await readFile(path.join(ROOT, "distribution-manifest.json"), "utf8"));
    assert.equal(manifest.kind, "guardrail-harness-public-candidate");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
