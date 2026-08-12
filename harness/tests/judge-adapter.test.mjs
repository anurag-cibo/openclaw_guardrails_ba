import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runJudgeOffline } from "../src/adapters/judge-offline.mjs";
import { executeJudgeRun } from "../src/lib/judge-run.mjs";
import { verifyRunArtifacts } from "../src/lib/run-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_SOURCE = path.join(ROOT, "vendor/plugin-baseline/src/policy.js");
const JUDGE_SOURCE = path.join(ROOT, "vendor/plugin-baseline/src/judge.js");
const POLICY_CORPUS = path.join(ROOT, "corpora/research/policy_corpus.jsonl");
const EVASION_CORPUS = path.join(ROOT, "corpora/research/evasion_corpus.jsonl");
const HISTORICAL_RUNNER = path.join(ROOT, "runners/run_judge_offline.mjs");

async function temporaryDirectory(t, label = "harness-judge-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), label));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function ollamaResponse(payload, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    text: async () => JSON.stringify({ message: { content: JSON.stringify(payload) } }),
  });
}

function tagsResponse(models = ["qwen3:30b"]) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ models: models.map((name) => ({ name, digest: `digest-${name}`, details: {} })) }),
  });
}

test("productive judge contract accepts valid output and fails closed on uncertainty", async () => {
  const { evaluateWithJudge } = await import(pathToFileURL(JUDGE_SOURCE).href);
  const input = {
    command: "echo hello",
    workdir: "/home/node/.openclaw/workspace",
    deterministicVerdict: { decision: "escalate_llm", ruleId: "exec.unknown.escalate", normalized: {} },
  };
  const valid = await evaluateWithJudge(input, {
    model: "qwen3:30b",
    fetchImpl: ollamaResponse({ decision: "allow", confidence: "high", riskCategory: "readonly", reason: "safe" }),
  });
  assert.equal(valid.decision, "allow");
  assert.equal(valid.ruleId, "llm_judge.allow");

  const low = await evaluateWithJudge(input, {
    model: "qwen3:30b",
    fetchImpl: ollamaResponse({ decision: "allow", confidence: "low", riskCategory: "readonly", reason: "unsure" }),
  });
  assert.equal(low.decision, "block");
  assert.equal(low.ruleId, "llm_judge.fallback.block");

  const malformed = await evaluateWithJudge(input, {
    model: "qwen3:30b",
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not-json" }),
  });
  assert.equal(malformed.decision, "block");
  assert.equal(malformed.ruleId, "llm_judge.fallback.block");

  const httpError = await evaluateWithJudge(input, {
    model: "qwen3:30b",
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "" }),
  });
  assert.equal(httpError.decision, "block");
  assert.match(httpError.judgeReason, /HTTP error: 503/);
});

test("E4 mock adapter is field-compatible with the frozen historical runner", async (t) => {
  const directory = await temporaryDirectory(t, "harness-e4-parity-");
  const rawOutput = path.join(directory, "new.jsonl");
  const current = await runJudgeOffline({
    corpusPaths: [POLICY_CORPUS, EVASION_CORPUS],
    corpusReference: ["corpora/research/policy_corpus.jsonl", "corpora/research/evasion_corpus.jsonl"],
    policySource: POLICY_SOURCE,
    judgeSource: JUDGE_SOURCE,
    rawOutput,
    summaryOutput: path.join(directory, "summary.json"),
    expectedCases: 152,
    expectedEligibleCases: 78,
    models: ["qwen3:30b"],
    repetitions: 1,
    mock: true,
  });
  const mergedCorpus = path.join(directory, "judge-core.jsonl");
  await writeFile(mergedCorpus, `${(await readFile(POLICY_CORPUS, "utf8")).trim()}\n${(await readFile(EVASION_CORPUS, "utf8")).trim()}\n`, "utf8");
  const historicalOutput = path.join(directory, "historical.jsonl");
  const historicalRun = spawnSync(process.execPath, [HISTORICAL_RUNNER, mergedCorpus, historicalOutput], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GUARDRAIL_SRC: path.dirname(POLICY_SOURCE),
      JUDGE_MODELS: "qwen3:30b",
      JUDGE_REPS: "1",
      JUDGE_MOCK: "1",
    },
  });
  assert.equal(historicalRun.status, 0, historicalRun.stderr);
  const historical = (await readFile(historicalOutput, "utf8"))
    .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  const fields = [
    "model", "id", "risk_class", "command", "rep", "risk", "effect",
    "det_decision", "det_rule", "judge_raw_decision", "judge_confidence",
    "judge_risk_category", "final_decision", "is_fallback", "judge_correct", "reason",
  ];
  const project = (rows) => rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
  assert.deepEqual(project(current.rows), project(historical));
  assert.equal(current.eligible.length, 78);
  assert.equal(current.summary.calls, 78);
  assert.equal(current.summary.byModel["qwen3:30b"].fallback, 0);
});

test("judge quality gate rejects excessive fail-closed fallbacks", async (t) => {
  const directory = await temporaryDirectory(t, "harness-e4-fallback-");
  await assert.rejects(runJudgeOffline({
    corpusPaths: [POLICY_CORPUS, EVASION_CORPUS],
    policySource: POLICY_SOURCE,
    judgeSource: JUDGE_SOURCE,
    rawOutput: path.join(directory, "raw.jsonl"),
    summaryOutput: path.join(directory, "summary.json"),
    expectedCases: 152,
    expectedEligibleCases: 78,
    caseLimit: 4,
    models: ["qwen3:30b"],
    repetitions: 1,
    maxFallbackRate: 0,
    probeFetch: tagsResponse(),
    fetchFactory: () => async () => ({ ok: true, status: 200, text: async () => "not-json" }),
  }), (error) => {
    assert.match(error.message, /Fallbackrate über Grenzwert/);
    assert.equal(error.partialResult.summary.byModel["qwen3:30b"].fallback, 4);
    return true;
  });
});

test("judge adapter resumes only rows with the same configuration signature", async (t) => {
  const directory = await temporaryDirectory(t, "harness-e4-resume-");
  const completeOutput = path.join(directory, "complete.jsonl");
  const options = {
    corpusPaths: [POLICY_CORPUS, EVASION_CORPUS],
    policySource: POLICY_SOURCE,
    judgeSource: JUDGE_SOURCE,
    expectedCases: 152,
    expectedEligibleCases: 78,
    caseLimit: 8,
    models: ["qwen3:30b"],
    repetitions: 1,
    mock: true,
  };
  await runJudgeOffline({
    ...options,
    rawOutput: completeOutput,
    summaryOutput: path.join(directory, "complete-summary.json"),
  });
  const lines = (await readFile(completeOutput, "utf8")).trim().split("\n");
  const partialOutput = path.join(directory, "partial.jsonl");
  await writeFile(partialOutput, `${lines.slice(0, 3).join("\n")}\n`, "utf8");
  const resumed = await runJudgeOffline({
    ...options,
    rawOutput: partialOutput,
    summaryOutput: path.join(directory, "resumed-summary.json"),
    resume: true,
  });
  assert.equal(resumed.rows.length, 8);
  assert.equal(new Set(resumed.rows.map((row) => `${row.model}/${row.id}/${row.rep}`)).size, 8);

  const altered = JSON.parse(lines[0]);
  altered.configuration_signature = "0".repeat(64);
  await writeFile(path.join(directory, "wrong.jsonl"), `${JSON.stringify(altered)}\n`, "utf8");
  await assert.rejects(runJudgeOffline({
    ...options,
    rawOutput: path.join(directory, "wrong.jsonl"),
    summaryOutput: path.join(directory, "wrong-summary.json"),
    resume: true,
  }), /Resume-Konfigurationssignatur stimmt nicht/);
});

test("integrated E4 mock pilot completes but mock main is prohibited", async (t) => {
  const stateRoot = await temporaryDirectory(t, "harness-e4-run-");
  const run = await executeJudgeRun(ROOT, {
    kind: "pilot",
    requested: ["E4"],
    stateRoot,
    models: ["qwen3:30b"],
    mock: true,
  });
  assert.equal(run.status.state, "completed");
  assert.equal(run.status.stages[0].status, "succeeded");
  assert.equal(run.status.stages[0].artifacts.length, 3);
  assert.equal(run.manifest.metadata.judgeConfiguration.mock, true);
  assert.deepEqual(await verifyRunArtifacts(stateRoot, run.status.runId), {
    ok: true,
    checked: 3,
    errors: [],
  });

  await assert.rejects(executeJudgeRun(ROOT, {
    kind: "main",
    requested: ["E4"],
    stateRoot,
    mock: true,
  }), /Mock-Judge ist ausschließlich/);
});
