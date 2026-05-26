import test from "node:test";
import assert from "node:assert/strict";
import { toOpenClawHookResult } from "../src/approval.js";
import { Decisions } from "../src/decisions.js";

const approvalVerdict = {
  decision: Decisions.REQUIRE_APPROVAL,
  severity: "medium",
  reason: "recursive deletion of approval target",
  ruleId: "exec.delete.approval_target",
  targetCanonicals: ["/home/node/.openclaw/workspace/guardrail-lab/tmp"],
  normalized: {
    rawCommand: "rm -rf guardrail-lab/tmp"
  }
};

test("allow returns no hook result", () => {
  assert.equal(
    toOpenClawHookResult({ decision: Decisions.ALLOW }),
    undefined
  );
});

test("block keeps the minimal block hook result", () => {
  assert.deepEqual(
    toOpenClawHookResult({ decision: Decisions.BLOCK }),
    { block: true }
  );
});

test("require_approval returns structured OpenClaw approval metadata", () => {
  const result = toOpenClawHookResult(approvalVerdict);

  assert.equal(result.requireApproval.title, "Guardrail approval required");
  assert.equal(result.requireApproval.severity, "warning");
  assert.equal(result.requireApproval.timeoutMs, 60000);
  assert.equal(result.requireApproval.timeoutBehavior, "deny");
  assert.deepEqual(result.requireApproval.allowedDecisions, ["allow-once", "deny"]);
  assert.equal(result.requireApproval.pluginId, "guardrail-spike");
  assert.match(result.requireApproval.description, /recursive deletion/);
  assert.match(result.requireApproval.description, /rm -rf guardrail-lab\/tmp/);
  assert.match(result.requireApproval.description, /exec\.delete\.approval_target/);
  assert.match(result.requireApproval.description, /guardrail-lab\/tmp/);
});

test("approval severity maps high and critical to critical", () => {
  assert.equal(
    toOpenClawHookResult({ ...approvalVerdict, severity: "high" })
      .requireApproval.severity,
    "critical"
  );
  assert.equal(
    toOpenClawHookResult({ ...approvalVerdict, severity: "critical" })
      .requireApproval.severity,
    "critical"
  );
});

test("approval severity maps low and info to info", () => {
  assert.equal(
    toOpenClawHookResult({ ...approvalVerdict, severity: "low" })
      .requireApproval.severity,
    "info"
  );
  assert.equal(
    toOpenClawHookResult({ ...approvalVerdict, severity: "info" })
      .requireApproval.severity,
    "info"
  );
});

test("escalate_llm fallback behavior is preserved", () => {
  const verdict = {
    ...approvalVerdict,
    decision: Decisions.ESCALATE_LLM,
    severity: "high"
  };

  assert.deepEqual(toOpenClawHookResult(verdict), { block: true });
  assert.equal(
    toOpenClawHookResult(verdict, { escalateFallback: "allow" }),
    undefined
  );
  assert.equal(
    toOpenClawHookResult(verdict, { escalateFallback: "approval" })
      .requireApproval.severity,
    "critical"
  );
});
