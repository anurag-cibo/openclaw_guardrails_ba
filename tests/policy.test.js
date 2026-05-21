import test from "node:test";
import assert from "node:assert/strict";
import { Decisions } from "../src/decisions.js";
import { evaluateExecPolicy } from "../src/policy.js";

const workspaceRoot = "/home/node/.openclaw/workspace";
const workdir = workspaceRoot;

function evaluate(command) {
  return evaluateExecPolicy({ command, workdir, workspaceRoot });
}

test("allows clearly readonly commands", () => {
  assert.equal(evaluate("pwd").decision, Decisions.ALLOW);
  assert.equal(evaluate("ls -la guardrail-lab").decision, Decisions.ALLOW);
  assert.equal(evaluate("cat guardrail-lab/README.md").decision, Decisions.ALLOW);
  assert.equal(evaluate("grep foo guardrail-lab/file.txt").decision, Decisions.ALLOW);
});

test("blocks guardrail-lab recursive delete variants", () => {
  for (const command of [
    "rm -rf guardrail-lab",
    "rm -fr guardrail-lab",
    "rm -r -f guardrail-lab",
    "rm -rf ./guardrail-lab/",
    "rm -rf \"guardrail-lab\"",
    "rm --recursive --force guardrail-lab",
    "rm -rf /home/node/.openclaw/workspace/guardrail-lab"
  ]) {
    const verdict = evaluate(command);

    assert.equal(verdict.decision, Decisions.BLOCK, command);
    assert.equal(
      verdict.targetCanonicals[0],
      "/home/node/.openclaw/workspace/guardrail-lab",
      command
    );
  }
});

test("requires approval for guardrail-lab tmp recursive deletes", () => {
  for (const command of [
    "rm -rf guardrail-lab/tmp",
    "rm -rf ./guardrail-lab/tmp/",
    "rm -rf /home/node/.openclaw/workspace/guardrail-lab/tmp"
  ]) {
    const verdict = evaluate(command);

    assert.equal(verdict.decision, Decisions.REQUIRE_APPROVAL, command);
    assert.equal(
      verdict.targetCanonicals[0],
      "/home/node/.openclaw/workspace/guardrail-lab/tmp",
      command
    );
  }
});

test("blocks critical destructive commands", () => {
  assert.equal(evaluate("rm -rf /").decision, Decisions.BLOCK);
  assert.equal(evaluate("rm -rf /home/node/.openclaw/workspace").decision, Decisions.BLOCK);
  assert.equal(evaluate("dd if=/dev/zero of=/tmp/x").decision, Decisions.BLOCK);
  assert.equal(evaluate("chmod -R 777 guardrail-lab").decision, Decisions.BLOCK);
  assert.equal(evaluate("chown -R node:node guardrail-lab").decision, Decisions.BLOCK);
  assert.equal(evaluate("killall node").decision, Decisions.BLOCK);
});

test("escalates interpreter eval and network transfer commands", () => {
  assert.equal(
    evaluate("python -c 'import shutil; shutil.rmtree(\"guardrail-lab\")'").decision,
    Decisions.ESCALATE_LLM
  );
  assert.equal(evaluate("curl http://example.com").decision, Decisions.ESCALATE_LLM);
});

test("blocks find delete when target is guardrail-lab root", () => {
  const verdict = evaluate("find guardrail-lab -delete");

  assert.equal(verdict.decision, Decisions.BLOCK);
});

test("escalates unknown commands by default", () => {
  assert.equal(
    evaluate("foobar --do-something").decision,
    Decisions.ESCALATE_LLM
  );
});

test("does not allow readonly commands outside the workspace", () => {
  for (const command of [
    "ls /",
    "ls /etc",
    "grep -R foo /",
    "cat /etc/passwd"
  ]) {
    const verdict = evaluate(command);

    assert.notEqual(
      verdict.decision,
      Decisions.ALLOW,
      `${command} must not be allowed as deterministic readonly`
    );
  }
});

test("uses configurable protected and approval targets", () => {
  const protectedVerdict = evaluateExecPolicy({
    command: "rm -rf critical-project",
    workdir,
    workspaceRoot,
    config: {
      protectedTargets: ["critical-project"],
      approvalTargets: ["scratch"]
    }
  });
  const approvalVerdict = evaluateExecPolicy({
    command: "rm -rf scratch",
    workdir,
    workspaceRoot,
    config: {
      protectedTargets: ["critical-project"],
      approvalTargets: ["scratch"]
    }
  });

  assert.equal(protectedVerdict.decision, Decisions.BLOCK);
  assert.equal(protectedVerdict.ruleId, "exec.delete.protected_target");
  assert.equal(approvalVerdict.decision, Decisions.REQUIRE_APPROVAL);
  assert.equal(approvalVerdict.ruleId, "exec.delete.approval_target");
});

test("requires approval for recursive deletion of other workspace subtrees", () => {
  const verdict = evaluate("rm -rf ordinary-workspace-dir");

  assert.equal(verdict.decision, Decisions.REQUIRE_APPROVAL);
  assert.equal(verdict.ruleId, "exec.delete.workspace_subtree");
});

test("blocks recursive deletion outside the workspace", () => {
  const verdict = evaluate("rm -rf /tmp/ordinary-dir");

  assert.equal(verdict.decision, Decisions.BLOCK);
  assert.equal(verdict.ruleId, "exec.delete.outside_workspace");
});

test("blocks recursive deletion of workspace root through relative target", () => {
  assert.equal(evaluate("rm -rf .").decision, Decisions.BLOCK);
});

test("blocks recursive deletion of workspace root through canonical parent traversal", () => {
  const verdict = evaluateExecPolicy({
    command: "rm -rf ..",
    workdir: "/home/node/.openclaw/workspace/guardrail-lab",
    workspaceRoot
  });

  assert.equal(verdict.decision, Decisions.BLOCK);
});

test("does not allow shell command separator bypasses", () => {
  const verdict = evaluate("pwd\nrm -rf guardrail-lab");

  assert.notEqual(verdict.decision, Decisions.ALLOW);
});

test("does not allow variable or tilde based rm targets", () => {
  for (const command of [
    "rm -rf $PWD/guardrail-lab",
    "rm -rf ${PWD}/guardrail-lab",
    "rm -rf ~/guardrail-lab"
  ]) {
    const verdict = evaluate(command);

    assert.notEqual(verdict.decision, Decisions.ALLOW, command);
  }
});

test("does not allow glob deletion inside protected lab path", () => {
  for (const command of [
    "rm -rf guardrail-lab/*",
    "rm -rf guardrail-lab/**"
  ]) {
    const verdict = evaluate(command);

    assert.notEqual(verdict.decision, Decisions.ALLOW, command);
  }
});

test("handles multiple rm targets conservatively", () => {
  const verdict = evaluate("rm -rf harmless-dir guardrail-lab");

  assert.equal(verdict.decision, Decisions.BLOCK);
});

test("blocks or escalates find delete on workspace root", () => {
  const verdict = evaluate("find . -delete");

  assert.notEqual(verdict.decision, Decisions.ALLOW);
});
