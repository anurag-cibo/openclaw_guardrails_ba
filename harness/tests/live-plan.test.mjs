import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadApprovalCorpus, loadLiveCorpus, validateApprovalCorpusRows } from "../src/lib/live-corpus.mjs";
import { makeLivePlan } from "../src/lib/live-plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("live and approval corpora satisfy their explicit contracts", async () => {
  const live = await loadLiveCorpus(path.join(ROOT, "corpora/research/live_corpus.jsonl"), { expectedCases: 26 });
  const approval = await loadApprovalCorpus(path.join(ROOT, "corpora/research/e6b_corpus.jsonl"), { expectedCases: 6 });
  const pilotLive = await loadLiveCorpus(path.join(ROOT, "corpora/pilot/live.jsonl"), { expectedCases: 4 });
  const pilotApproval = await loadApprovalCorpus(path.join(ROOT, "corpora/pilot/approval.jsonl"), { expectedCases: 5 });
  const publicPolicy = await loadLiveCorpus(path.join(ROOT, "corpora/pilot/live.jsonl"), { expectedCases: 4 });
  assert.equal(live.cases.filter((row) => row.risk === 0).length > 0, true);
  assert.equal(approval.cases.filter((row) => row.in_default_matrix).length, 5);
  assert.deepEqual(pilotLive.cases.map((row) => row.id), ["L-DB-01", "L-DB-04", "L-DR-01", "L-DR-02"]);
  assert.equal(pilotApproval.cases.filter((row) => row.in_default_matrix).length, 5);
  assert.equal(publicPolicy.cases.length, 4);
  assert.throws(() => validateApprovalCorpusRows([{ ...approval.cases[0], arms: ["invented"] }]), /Approval-Arme/u);
});

test("main live plan exactly reconstructs E5, E6a and E6b matrices", async () => {
  const plan = await makeLivePlan(ROOT, { kind: "main" });
  const counts = Object.fromEntries(plan.stages.map((stage) => [stage.id, stage.expectedRows]));
  assert.deepEqual(counts, { E5: 580, E6a: 20, E6b: 290 });
  assert.equal(plan.expectedRows, 890);
  assert.deepEqual(plan.stages.find((stage) => stage.id === "E5").phases.map((phase) => phase.expectedRows), [520, 60]);
});

test("pilot live plan is bounded, deterministic and selectable", async () => {
  const plan = await makeLivePlan(ROOT, { kind: "pilot", requested: ["E5", "E6b"] });
  assert.deepEqual(plan.stages.map((stage) => stage.id), ["E5", "E6b"]);
  assert.equal(plan.corpora.live.cases, 4);
  assert.equal(plan.corpora.approval.cases, 5);
  assert.equal(plan.stages[0].expectedRows, 16);
  assert.equal(plan.stages[1].expectedRows, 12);
  assert.match(plan.stages[0].phases[0].environment.CASE_IDS, /L-DB-01/u);
  assert.equal(plan.stages[0].phases[0].environment.CORPUS, "corpora/pilot/live.jsonl");
  assert.equal(plan.stages[1].phases[0].environment.CORPUS, "corpora/pilot/approval.jsonl");
  assert.equal(plan.stages[1].phases[0].maxAttempts, 3);
});

test("E6a uses the stabilized adapter with active Gateway readiness", async () => {
  const plan = await makeLivePlan(ROOT, { kind: "pilot", requested: ["E6a"] });
  assert.equal(plan.stages[0].phases[0].script, "adapters/live/run_e6.sh");
  const adapter = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(ROOT, plan.stages[0].phases[0].script), "utf8"));
  assert.match(adapter, /wait_for_gateway_rpc/u);
  assert.match(adapter, /wait-gateway-rpc\.sh/u);
  assert.doesNotMatch(adapter, /run "sleep 6"/u);
});

test("E5 and E6b use the tested Gateway-readiness compatibility adapter", async () => {
  const plan = await makeLivePlan(ROOT, { profilePath: "profiles/live-pilot.example.json" });
  assert.equal(plan.stages.find((stage) => stage.id === "E5").phases[0].script, "adapters/live/run_e5.sh");
  assert.equal(plan.stages.find((stage) => stage.id === "E6b").phases[0].script, "adapters/live/run_e6b.sh");
  for (const stage of plan.stages) {
    assert.equal(stage.phases[0].environment.GATEWAY_READY_ATTEMPTS, "30");
    assert.equal(stage.phases[0].maxAttempts, 3);
  }
});

test("live plan rejects unsupported experiment IDs before execution", async () => {
  await assert.rejects(makeLivePlan(ROOT, { kind: "pilot", requested: ["E4"] }), /keine Live-\/Approval-Freigabe/iu);
});
