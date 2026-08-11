import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CorpusValidationError,
  loadPolicyCorpus,
  selectPilotCases,
} from "../src/lib/corpus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harness-corpus-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("documented minimal corpus is valid JSONL", async () => {
  const corpus = await loadPolicyCorpus(path.join(ROOT, "corpora/examples/minimal_policy.jsonl"));
  assert.equal(corpus.cases.length, 2);
  assert.deepEqual(corpus.cases.map((row) => row.expected_decision), ["allow", "block"]);
  assert.match(corpus.sha256, /^[a-f0-9]{64}$/);
});

test("corpus loader reports the exact line for invalid JSON and ground truth", async (t) => {
  const directory = await temporaryDirectory(t);
  const invalidJson = path.join(directory, "invalid-json.jsonl");
  await writeFile(invalidJson, '{"id":"ok"}\nnot-json\n', "utf8");
  await assert.rejects(loadPolicyCorpus(invalidJson), (error) => {
    assert.equal(error instanceof CorpusValidationError, true);
    assert.equal(error.line, 1);
    assert.match(error.message, /Feld 'suite'/);
    return true;
  });

  const invalidRisk = path.join(directory, "invalid-risk.jsonl");
  await writeFile(invalidRisk, `${JSON.stringify({
    id: "X", suite: "demo", risk_class: "x", command: "pwd",
    expected_decision: "allow", risk: "0",
  })}\n`, "utf8");
  await assert.rejects(loadPolicyCorpus(invalidRisk), /Feld 'risk' muss die Zahl 0 oder 1 sein/);
});

test("corpus loader rejects duplicate IDs", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "duplicate.jsonl");
  const row = {
    id: "DUP", suite: "demo", risk_class: "safe", command: "pwd",
    expected_decision: "allow", risk: 0,
  };
  await writeFile(file, `${JSON.stringify(row)}\n${JSON.stringify(row)}\n`, "utf8");
  await assert.rejects(loadPolicyCorpus(file), /doppelte Fall-ID 'DUP'/);
});

test("corpus loader rejects invalid UTF-8", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "invalid-utf8.jsonl");
  await writeFile(file, Buffer.from([0xc3, 0x28]));
  await assert.rejects(loadPolicyCorpus(file), /Datei ist nicht gültiges UTF-8/);
});

test("pilot selection is deterministic and stratified", async () => {
  const corpus = await loadPolicyCorpus(path.join(ROOT, "corpora/research/policy_corpus.jsonl"), {
    expectedCases: 116,
  });
  const first = selectPilotCases(corpus.cases, 8);
  const second = selectPilotCases(corpus.cases, 8);
  assert.deepEqual(first.map((row) => row.id), second.map((row) => row.id));
  assert.equal(first.length, 8);
  assert.equal(new Set(first.map((row) => row.risk)).size, 2);
  assert.ok(new Set(first.map((row) => row.expected_decision)).size >= 3);
  assert.ok(new Set(first.map((row) => row.risk_class)).size >= 4);
});
