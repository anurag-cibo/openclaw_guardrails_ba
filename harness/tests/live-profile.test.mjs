import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeLivePlan } from "../src/lib/live-plan.mjs";
import { loadLiveProfile } from "../src/lib/live-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = path.join(ROOT, "profiles/live-pilot.example.json");
const SMOKE = path.join(ROOT, "profiles/live-smoke.example.json");
const MAIN_PILOT = path.join(ROOT, "profiles/live-main-pilot.example.json");
const MAIN = path.join(ROOT, "profiles/live-main.example.json");

test("example profile selects public corpora and the bounded 32-row pilot", async () => {
  const profile = await loadLiveProfile(ROOT, EXAMPLE);
  assert.equal(profile.name, "public-example-pilot");
  assert.equal(profile.corpora.live.root, "harness");
  assert.equal(profile.corpora.live.path, "corpora/pilot/live.jsonl");
  assert.equal(profile.corpora.approval.path, "corpora/pilot/approval.jsonl");

  const plan = await makeLivePlan(ROOT, { profilePath: EXAMPLE });
  assert.equal(plan.kind, "pilot");
  assert.deepEqual(plan.stages.map((stage) => stage.id), ["E5", "E6a", "E6b"]);
  assert.equal(plan.expectedRows, 32);
  assert.equal(plan.profile.name, "public-example-pilot");
  assert.match(plan.profile.sha256, /^[a-f0-9]{64}$/u);
});

test("profile can select a subset without changing the profile file", async () => {
  const plan = await makeLivePlan(ROOT, { profilePath: EXAMPLE, requested: ["E6a"] });
  assert.deepEqual(plan.stages.map((stage) => stage.id), ["E6a"]);
  assert.equal(plan.expectedRows, 4);
});

test("public smoke profile is the bounded four-row E6a technical check", async () => {
  const plan = await makeLivePlan(ROOT, { profilePath: SMOKE });
  assert.deepEqual(plan.stages.map((stage) => stage.id), ["E6a"]);
  assert.equal(plan.expectedRows, 4);
});

test("compact pilot and main profiles share one 20-row measurement contract", async () => {
  const pilot = await makeLivePlan(ROOT, { profilePath: MAIN_PILOT });
  const main = await makeLivePlan(ROOT, { profilePath: MAIN });
  assert.equal(pilot.kind, "pilot");
  assert.equal(main.kind, "main");
  assert.equal(pilot.expectedRows, 20);
  assert.equal(main.expectedRows, 20);
  assert.deepEqual(main.stages.map((stage) => stage.id), ["E5", "E6a"]);
  assert.equal(main.measurementContract.fingerprint, pilot.measurementContract.fingerprint);
});

test("data-root profile reads external corpora but exposes only stable container paths", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "harness-data-root-"));
  const profileDirectory = await mkdtemp(path.join(ROOT, "profiles/local/test-data-root-"));
  try {
    await copyFile(path.join(ROOT, "corpora/pilot/live.jsonl"), path.join(dataRoot, "live.jsonl"));
    await copyFile(path.join(ROOT, "corpora/pilot/approval.jsonl"), path.join(dataRoot, "approval.jsonl"));
    const profile = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(EXAMPLE, "utf8")));
    profile.name = "external-data-test";
    profile.corpora = {
      live: { root: "data", path: "live.jsonl", cases: 4 },
      approval: { root: "data", path: "approval.jsonl", cases: 5 },
    };
    const profileFile = path.join(profileDirectory, "profile.json");
    await writeFile(profileFile, JSON.stringify(profile), "utf8");
    const loaded = await loadLiveProfile(ROOT, profileFile, { dataRoot });
    assert.equal(loaded.corpora.live.path, "/harness-data/live.jsonl");
    assert.equal(loaded.corpora.live.readPath, path.join(dataRoot, "live.jsonl"));
    const previousDataRoot = process.env.HARNESS_DATA_ROOT;
    process.env.HARNESS_DATA_ROOT = dataRoot;
    try {
      const plan = await makeLivePlan(ROOT, { profilePath: profileFile });
      assert.deepEqual(plan.corpora.live.root, "data");
      assert.equal(plan.corpora.live.path, "/harness-data/live.jsonl");
      assert.equal(JSON.stringify(plan).includes(dataRoot), false);
      assert.equal(plan.stages[0].phases[0].environment.CORPUS, "/harness-data/live.jsonl");
    } finally {
      if (previousDataRoot === undefined) delete process.env.HARNESS_DATA_ROOT;
      else process.env.HARNESS_DATA_ROOT = previousDataRoot;
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(profileDirectory, { recursive: true, force: true });
  }
});

test("data-root profile rejects absolute and escaping corpus paths", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "harness-data-root-invalid-"));
  const profileDirectory = await mkdtemp(path.join(ROOT, "profiles/local/test-data-root-invalid-"));
  try {
    const base = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(EXAMPLE, "utf8")));
    base.corpora.live = { root: "data", path: "../escape.jsonl", cases: 4 };
    const escaping = path.join(profileDirectory, "escaping.json");
    await writeFile(escaping, JSON.stringify(base), "utf8");
    await assert.rejects(loadLiveProfile(ROOT, escaping, { dataRoot }), /verlÃ¤sst HARNESS_DATA_ROOT/u);
    base.corpora.live.path = path.join(dataRoot, "absolute.jsonl");
    const absolute = path.join(profileDirectory, "absolute.json");
    await writeFile(absolute, JSON.stringify(base), "utf8");
    await assert.rejects(loadLiveProfile(ROOT, absolute, { dataRoot }), /muss path relativ sein/u);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(profileDirectory, { recursive: true, force: true });
  }
});

test("data-root profile rejects a corpus symlink escaping the mounted root", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows without Developer Mode cannot create the required symlink; Linux contract remains mandatory");
    return;
  }
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "harness-data-root-link-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "harness-data-outside-"));
  const profileDirectory = await mkdtemp(path.join(ROOT, "profiles/local/test-data-root-link-"));
  try {
    const outside = path.join(outsideRoot, "live.jsonl");
    await copyFile(path.join(ROOT, "corpora/pilot/live.jsonl"), outside);
    await symlink(outside, path.join(dataRoot, "live.jsonl"));
    await copyFile(path.join(ROOT, "corpora/pilot/approval.jsonl"), path.join(dataRoot, "approval.jsonl"));
    const base = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(EXAMPLE, "utf8")));
    base.corpora = {
      live: { root: "data", path: "live.jsonl", cases: 4 },
      approval: { root: "data", path: "approval.jsonl", cases: 5 },
    };
    const profileFile = path.join(profileDirectory, "link.json");
    await writeFile(profileFile, JSON.stringify(base), "utf8");
    await assert.rejects(loadLiveProfile(ROOT, profileFile, { dataRoot }), /innerhalb von HARNESS_DATA_ROOT/u);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
    await rm(profileDirectory, { recursive: true, force: true });
  }
});

test("profile matrix controls row counts, cases, configurations, arms and retries", async () => {
  const base = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(EXAMPLE, "utf8")));
  const temporary = await mkdtemp(path.join(ROOT, "profiles/local/test-matrix-"));
  try {
    base.corpora.live.path = path.join(ROOT, "corpora/pilot/live.jsonl");
    base.corpora.approval.path = path.join(ROOT, "corpora/pilot/approval.jsonl");
    base.matrix.E5 = { configs: ["C1", "C3"], caseIds: ["L-DB-01", "L-DR-02"], reps: 2, c3ApprovalPolicy: "allow-once" };
    base.matrix.E6a = { caseId: "L-DR-02", arms: ["deny", "allow-once"], reps: 2, c2Reps: 1 };
    base.matrix.E6b = { caseIds: ["E6B-01", "E6B-02"], arms: ["deny"], reps: 3, c2Reps: 0, c2CaseId: "E6B-01" };
    base.retry = { phaseAttempts: 4, phaseDelayMs: 3210, gatewayAttempts: 9, gatewayIntervalSeconds: 1.5, gatewayTimeoutSeconds: 4, toolPreflightAttempts: 6 };
    const profileFile = path.join(temporary, "matrix.json");
    await writeFile(profileFile, JSON.stringify(base), "utf8");
    const plan = await makeLivePlan(ROOT, { profilePath: profileFile });
    assert.deepEqual(Object.fromEntries(plan.stages.map((stage) => [stage.id, stage.expectedRows])), { E5: 8, E6a: 5, E6b: 6 });
    assert.equal(plan.expectedRows, 19);
    const e5 = plan.stages[0].phases[0];
    assert.equal(e5.environment.CONFIGS, "C1 C3");
    assert.equal(e5.environment.REPS, "2");
    assert.equal(e5.environment.C3_APPROVAL_POLICY, "allow-once");
    assert.equal(e5.maxAttempts, 4);
    assert.equal(e5.retryDelayMs, 3210);
    assert.equal(e5.environment.GATEWAY_READY_INTERVAL_SECONDS, "1.5");
    assert.equal(plan.stages[1].phases[0].environment.E6_ARMS, "deny allow-once");
    assert.equal(plan.stages[2].phases[0].environment.E6B_ARMS, "deny");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("profile rejects corpus paths outside the Harness boundary", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-profile-"));
  try {
    const outside = path.join(temporary, "outside.jsonl");
    await writeFile(outside, "{}\n", "utf8");
    const profileFile = path.join(temporary, "outside-profile.json");
    await writeFile(profileFile, JSON.stringify({
      schemaVersion: 1,
      name: "outside",
      kind: "pilot",
      experiments: ["E6a"],
      corpora: {
        live: { path: outside, cases: 1 },
        approval: { path: path.join(ROOT, "corpora/pilot/approval.jsonl"), cases: 5 },
      },
    }), "utf8");
    await assert.rejects(loadLiveProfile(ROOT, profileFile), /innerhalb von Harness/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("profile rejects unknown fields and unknown run kinds", async () => {
  const base = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(EXAMPLE, "utf8")));
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-profile-invalid-"));
  try {
    const unknownFile = path.join(temporary, "unknown.json");
    await writeFile(unknownFile, JSON.stringify({ ...base, invented: true }), "utf8");
    await assert.rejects(loadLiveProfile(ROOT, unknownFile), /unbekannte Felder/u);
    const unknownKindFile = path.join(temporary, "unknown-kind.json");
    await writeFile(unknownKindFile, JSON.stringify({ ...base, kind: "benchmark" }), "utf8");
    await assert.rejects(loadLiveProfile(ROOT, unknownKindFile), /kind muss 'pilot' oder 'main'/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("profile rejects shell-unsafe model names and credential-bearing endpoints", async () => {
  const base = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(EXAMPLE, "utf8")));
  const temporary = await mkdtemp(path.join(ROOT, "profiles/local/test-models-"));
  try {
    base.corpora.live.path = path.join(ROOT, "corpora/pilot/live.jsonl");
    base.corpora.approval.path = path.join(ROOT, "corpora/pilot/approval.jsonl");
    base.models.agent = "qwen3:30b\nINJECTED=1";
    const unsafeModel = path.join(temporary, "unsafe-model.json");
    await writeFile(unsafeModel, JSON.stringify(base), "utf8");
    await assert.rejects(loadLiveProfile(ROOT, unsafeModel), /unzulässige Zeichen/u);
    base.models.agent = "qwen3:30b";
    base.models.judgeBaseUrl = "http://user:secret@ollama:11434";
    const unsafeUrl = path.join(temporary, "unsafe-url.json");
    await writeFile(unsafeUrl, JSON.stringify(base), "utf8");
    await assert.rejects(loadLiveProfile(ROOT, unsafeUrl), /ohne Zugangsdaten/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
