import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeExecCommand,
  tokenizeShellLike
} from "../src/normalize-command.js";

const workspaceRoot = "/home/node/.openclaw/workspace";
const workdir = workspaceRoot;

function normalize(command) {
  return normalizeExecCommand({ command, workdir, workspaceRoot });
}

test("tokenizeShellLike splits simple commands", () => {
  assert.deepEqual(tokenizeShellLike("rm -rf guardrail-lab"), [
    "rm",
    "-rf",
    "guardrail-lab"
  ]);
});

test("tokenizeShellLike removes surrounding quotes", () => {
  assert.deepEqual(tokenizeShellLike('rm -rf "guardrail-lab"'), [
    "rm",
    "-rf",
    "guardrail-lab"
  ]);
});

test("normalizes rm recursive variants to the same guardrail-lab canonical path", () => {
  for (const command of [
    "rm -rf guardrail-lab",
    "rm -fr guardrail-lab",
    "rm -r -f guardrail-lab",
    "rm -rf ./guardrail-lab/",
    "rm -rf \"guardrail-lab\"",
    "rm -rf '/home/node/.openclaw/workspace/guardrail-lab'",
    "rm -rf /home/node/.openclaw/workspace/guardrail-lab"
  ]) {
    const normalized = normalize(command);

    assert.equal(normalized.programBase, "rm");
    assert.equal(normalized.operation, "recursive_delete");
    assert.equal(
      normalized.targetCanonicals[0],
      "/home/node/.openclaw/workspace/guardrail-lab",
      command
    );
    assert.equal(normalized.targetInfos[0].isProtectedTarget, true, command);
    assert.equal(normalized.targetInfos[0].scope, "inside_workspace", command);
  }
});

test("normalizes guardrail-lab tmp target variants", () => {
  for (const command of [
    "rm -rf guardrail-lab/tmp",
    "rm -rf ./guardrail-lab/tmp/",
    "rm -rf \"guardrail-lab/tmp\"",
    "rm -rf /home/node/.openclaw/workspace/guardrail-lab/tmp"
  ]) {
    const normalized = normalize(command);

    assert.equal(normalized.operation, "recursive_delete");
    assert.equal(
      normalized.targetCanonicals[0],
      "/home/node/.openclaw/workspace/guardrail-lab/tmp",
      command
    );
    assert.equal(normalized.targetInfos[0].isApprovalTarget, true, command);
    assert.equal(normalized.targetInfos[0].scope, "inside_workspace", command);
  }
});

test("detects complex shell operators", () => {
  const normalized = normalize("cd x && rm -rf guardrail-lab");

  assert.equal(normalized.complexShell, true);
});

test("detects interpreter eval commands", () => {
  const normalized = normalize(
    "python -c 'import shutil; shutil.rmtree(\"guardrail-lab\")'"
  );

  assert.equal(normalized.programBase, "python");
  assert.equal(normalized.operation, "interpreter_eval");
});

test("detects newline as complex shell syntax", () => {
  const normalized = normalize("pwd\nrm -rf guardrail-lab");

  assert.equal(normalized.complexShell, true);
});

test("detects variable and tilde expansion as complex or warning-worthy", () => {
  for (const command of [
    "rm -rf $PWD/guardrail-lab",
    "rm -rf ${PWD}/guardrail-lab",
    "rm -rf ~/guardrail-lab"
  ]) {
    const normalized = normalize(command);

    assert.equal(
      normalized.complexShell,
      true,
      `${command} should not be treated as a simple literal path`
    );
  }
});

test("detects glob targets as complex or warning-worthy", () => {
  for (const command of [
    "rm -rf guardrail-lab/*",
    "rm -rf guardrail-lab/**",
    "rm -rf guardrail-lab/.[!.]*"
  ]) {
    const normalized = normalize(command);

    assert.equal(
      normalized.complexShell,
      true,
      `${command} should not be treated as a simple literal path`
    );
  }
});

test("normalizes option terminator for rm targets", () => {
  const normalized = normalize("rm -rf -- guardrail-lab");

  assert.equal(normalized.operation, "recursive_delete");
  assert.equal(
    normalized.targetCanonicals[0],
    "/home/node/.openclaw/workspace/guardrail-lab"
  );
  assert.equal(normalized.targetInfos[0].isProtectedTarget, true);
});

test("supports configurable protected and approval targets", () => {
  const protectedNormalized = normalizeExecCommand({
    command: "rm -rf critical-project",
    workdir,
    workspaceRoot,
    protectedTargets: ["critical-project"],
    approvalTargets: ["scratch"]
  });
  const approvalNormalized = normalizeExecCommand({
    command: "rm -rf scratch",
    workdir,
    workspaceRoot,
    protectedTargets: ["critical-project"],
    approvalTargets: ["scratch"]
  });

  assert.equal(protectedNormalized.targetInfos[0].isProtectedTarget, true);
  assert.equal(
    protectedNormalized.targetCanonicals[0],
    "/home/node/.openclaw/workspace/critical-project"
  );
  assert.equal(approvalNormalized.targetInfos[0].isApprovalTarget, true);
  assert.equal(
    approvalNormalized.targetCanonicals[0],
    "/home/node/.openclaw/workspace/scratch"
  );
});

test("normalizes workspace root via dot target", () => {
  const normalized = normalize("rm -rf .");

  assert.equal(normalized.operation, "recursive_delete");
  assert.equal(normalized.targetInfos[0].isWorkspaceRoot, true);
});
