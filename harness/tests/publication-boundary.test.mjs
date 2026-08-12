import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadApprovalCorpus, loadLiveCorpus } from "../src/lib/live-corpus.mjs";
import { makeLivePlan } from "../src/lib/live-plan.mjs";
import { buildPublicDistribution } from "../src/tools/build-public-distribution.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public pilot contains only the bounded sanitized sample", async () => {
  const live = await loadLiveCorpus(path.join(ROOT, "corpora/pilot/live.jsonl"), { expectedCases: 4 });
  const approval = await loadApprovalCorpus(path.join(ROOT, "corpora/pilot/approval.jsonl"), { expectedCases: 5 });
  const forbiddenStudyFields = ["refusal_observed", "policy_source", "source"];
  for (const row of [...live.cases, ...approval.cases]) {
    for (const field of forbiddenStudyFields) assert.equal(Object.hasOwn(row, field), false, `${row.id}: ${field}`);
  }
  assert.equal(approval.cases.every((row) => row.reps === 1), true);

  const plan = await makeLivePlan(ROOT, { kind: "pilot" });
  assert.equal(plan.expectedRows, 32);
  assert.equal(plan.stages.every((stage) => stage.phases.every((phase) => phase.environment.CORPUS?.startsWith("corpora/pilot/"))), true);
});

test("publication policy and ignore rules protect private research data", async () => {
  const policy = JSON.parse(await readFile(path.join(ROOT, "registry/publication-policy.json"), "utf8"));
  const ignore = await readFile(path.join(ROOT, ".gitignore"), "utf8");
  assert.equal(policy.status, "release-candidate-local");
  assert.equal(policy.publicationReviewRequired, true);
  assert.equal(policy.publicBuilder, "src/tools/build-public-distribution.mjs");
  for (const marker of ["/corpora/custom/*", "/corpora/private/*", "/profiles/local/*", "/corpora/research/*.jsonl", "/reference/e5aeg_archive/results/"]) {
    assert.match(ignore, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("allowlist builder creates a clean, self-testing public candidate", async () => {
  const parent = os.tmpdir();
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(path.join(parent, "test-candidate-"));
  try {
    const result = await buildPublicDistribution(output);
    assert.equal(result.bytes < 2 * 1024 * 1024, true);
    const manifest = JSON.parse(await readFile(path.join(output, "distribution-manifest.json"), "utf8"));
    assert.equal(manifest.kind, "guardrail-harness-public-candidate");
    assert.equal(manifest.entries.some((entry) => entry.path.startsWith("reference/")), false);
    const selfTest = spawnSync(process.execPath, ["--test", "tests/public-smoke.test.mjs"], {
      cwd: output,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(selfTest.status, 0, `${selfTest.stdout}\n${selfTest.stderr}`);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
