import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildReferenceMetricsBundle, writeReferenceMetricsBundle } from "../src/lib/metrics-bundle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("reference metric bundle merges authoritative components and overrides Windows E3", async () => {
  const bundle = await buildReferenceMetricsBundle(ROOT);
  assert.equal(bundle.validation.anchorsPassed, true);
  assert.equal(bundle.finalEligibility.eligibleAsNewHarnessMainRun, false);
  assert.equal(bundle.components.core.metrics.e3_latenz.variant, "haw_target_replication");
  assert.equal(bundle.components.core.metrics.e3_latenz.overall_self.pooled_mean_ms, 0.035919999999999994);
  assert.equal(bundle.superseded.e3Windows.metrics.overall_self.mean_ms, 0.0531);
  assert.deepEqual(bundle.anchors.e5aeg.successes, { C0: 60, C1: 7, C2: 60, C3: 59 });
});

test("reference metric bundle output is deterministic and carries every source hash", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-metrics-"));
  try {
    const first = await writeReferenceMetricsBundle(ROOT, path.join(temporary, "first.json"));
    const second = await writeReferenceMetricsBundle(ROOT, path.join(temporary, "second.json"));
    assert.equal(first.sha256, second.sha256);
    assert.equal(await readFile(first.output, "utf8"), await readFile(second.output, "utf8"));
    for (const source of Object.values(first.bundle.provenance.sources)) {
      assert.match(source.sha256, /^[a-f0-9]{64}$/);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
