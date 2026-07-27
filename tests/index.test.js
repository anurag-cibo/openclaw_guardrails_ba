import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../src/index.js";

function createHarness(pluginConfig) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guardrail-index-test-"));
  const logFile = path.join(directory, "guardrail.jsonl");
  const handlers = new Map();
  const api = {
    pluginConfig: {
      ...pluginConfig,
      logFile
    },
    on(event, handler) {
      handlers.set(event, handler);
    }
  };

  plugin.register(api);

  return {
    async exec(command) {
      const result = await handlers.get("before_tool_call")({
        toolName: "exec",
        params: { command },
        runId: "run-test",
        toolCallId: "call-test"
      });
      const events = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const event = events.filter((entry) => entry.event === "before_tool_call").at(-1);
      return { result, event, events, logFile };
    }
  };
}

function ollamaResponse(decision) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        message: {
          content: JSON.stringify({
            decision,
            confidence: "high",
            riskCategory: "workspace_write",
            reason: "test verdict"
          })
        }
      });
    }
  };
}

test("C0 observe logs the policy but neither invokes the judge nor enforces it", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return ollamaResponse("block");
  };

  try {
    const harness = createHarness({
      mode: "observe",
      judge: { enabled: true },
      hitl: { enabled: true }
    });
    const { result, event } = await harness.exec("unknown-program --flag");

    assert.equal(result, undefined);
    assert.equal(fetchCalls, 0);
    assert.equal(event.deterministicDecision, "escalate_llm");
    assert.equal(event.policyDecision, "escalate_llm");
    assert.equal(event.enforcementAction, "observe_allow");
    assert.equal(event.judgeInvoked, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("C1 maps deterministic require_approval to fail-closed block", async () => {
  const harness = createHarness({
    mode: "enforce",
    judge: { enabled: false },
    hitl: { enabled: false },
    escalateFallback: "block"
  });
  const { result, event } = await harness.exec("rm -rf guardrail-lab/tmp");

  assert.deepEqual(result, { block: true });
  assert.equal(event.policyDecision, "require_approval");
  assert.equal(event.enforcementAction, "block");
  assert.equal(event.hitlEnabled, false);
});

test("runtime protectedTargets and approvalTargets reach the deterministic policy", async () => {
  const harness = createHarness({
    mode: "enforce",
    protectedTargets: ["critical-project"],
    approvalTargets: ["scratch"],
    judge: { enabled: false },
    hitl: { enabled: true },
    escalateFallback: "block"
  });
  const protectedCall = await harness.exec("rm -rf critical-project");
  const approvalCall = await harness.exec("rm -rf scratch");

  assert.deepEqual(protectedCall.result, { block: true });
  assert.equal(protectedCall.event.policyDecision, "block");
  assert.ok(approvalCall.result.requireApproval);
  assert.equal(approvalCall.event.policyDecision, "require_approval");
});

test("C1 maps an unresolved deterministic escalation to fail-closed block", async () => {
  const harness = createHarness({
    mode: "enforce",
    judge: { enabled: false },
    hitl: { enabled: false },
    escalateFallback: "block"
  });
  const { result, event } = await harness.exec("unknown-program --flag");

  assert.deepEqual(result, { block: true });
  assert.equal(event.policyDecision, "escalate_llm");
  assert.equal(event.enforcementAction, "block");
  assert.equal(event.judgeInvoked, false);
});

test("canonical nested judge and HITL config overrides legacy flat keys", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return ollamaResponse("allow");
  };

  try {
    const harness = createHarness({
      mode: "enforce",
      judgeEnabled: true,
      judgeModel: "legacy-model",
      judgeTimeoutMs: 45000,
      judgeFallbackDecision: "block",
      hitlEnabled: true,
      judge: {
        enabled: false,
        model: "canonical-model",
        timeoutMs: 30000,
        fallbackDecision: "require_approval"
      },
      hitl: { enabled: false },
      escalateFallback: "block"
    });
    const { result, event } = await harness.exec("unknown-program --flag");

    assert.deepEqual(result, { block: true });
    assert.equal(fetchCalls, 0);
    assert.equal(event.judgeInvoked, false);
    assert.equal(event.hitlEnabled, false);
    assert.equal(event.policyDecision, "escalate_llm");
    assert.equal(event.enforcementAction, "block");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("C2 blocks a judge require_approval verdict when HITL is disabled", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ollamaResponse("require_approval");

  try {
    const harness = createHarness({
      mode: "enforce",
      judge: { enabled: true, fallbackDecision: "block" },
      hitl: { enabled: false },
      escalateFallback: "block"
    });
    const { result, event } = await harness.exec("unknown-program --flag");

    assert.deepEqual(result, { block: true });
    assert.equal(event.deterministicDecision, "escalate_llm");
    assert.equal(event.judgeDecision, "require_approval");
    assert.equal(event.policyDecision, "require_approval");
    assert.equal(event.enforcementAction, "block");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("C2 allows a high-confidence judge allow verdict", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ollamaResponse("allow");

  try {
    const harness = createHarness({
      mode: "enforce",
      judge: { enabled: true, fallbackDecision: "block" },
      hitl: { enabled: false },
      escalateFallback: "block"
    });
    const { result, event } = await harness.exec("unknown-program --flag");

    assert.equal(result, undefined);
    assert.equal(event.policyDecision, "allow");
    assert.equal(event.enforcementAction, "allow");
    assert.equal(event.judgeInvoked, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a deterministic block is never sent to or overridden by the judge", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return ollamaResponse("allow");
  };

  try {
    const harness = createHarness({
      mode: "enforce",
      judge: { enabled: true, fallbackDecision: "require_approval" },
      hitl: { enabled: true },
      escalateFallback: "block"
    });
    const { result, event } = await harness.exec("rm -rf guardrail-lab");

    assert.deepEqual(result, { block: true });
    assert.equal(fetchCalls, 0);
    assert.equal(event.deterministicDecision, "block");
    assert.equal(event.policyDecision, "block");
    assert.equal(event.enforcementAction, "block");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("C3 routes deterministic require_approval directly to HITL", async () => {
  const harness = createHarness({
    mode: "enforce",
    judge: { enabled: true, fallbackDecision: "require_approval" },
    hitl: { enabled: true },
    escalateFallback: "block"
  });
  const { result, event } = await harness.exec("rm -rf guardrail-lab/tmp");

  assert.ok(result.requireApproval);
  assert.equal(event.policyDecision, "require_approval");
  assert.equal(event.enforcementAction, "request_approval");
  assert.equal(event.judgeInvoked, false);
});

test("C3 logs the approval request and its gateway resolution", async () => {
  const harness = createHarness({
    mode: "enforce",
    judge: { enabled: false, fallbackDecision: "block" },
    hitl: { enabled: true },
    escalateFallback: "block"
  });
  const { result, events, logFile } = await harness.exec("rm -rf guardrail-lab/tmp");

  const request = events.find((entry) => entry.event === "approval_request");
  assert.equal(request.policyDecision, "require_approval");
  assert.deepEqual(request.allowedDecisions, ["allow-once", "deny"]);

  await result.requireApproval.onResolution("deny");
  const afterResolution = fs
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const resolution = afterResolution.find((entry) => entry.event === "approval_resolution");
  assert.equal(resolution.resolution, "deny");
  assert.equal(resolution.rawCommand, "rm -rf guardrail-lab/tmp");
});

test("C3 routes a regular judge require_approval verdict to HITL", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ollamaResponse("require_approval");

  try {
    const harness = createHarness({
      mode: "enforce",
      judge: { enabled: true, fallbackDecision: "require_approval" },
      hitl: { enabled: true },
      escalateFallback: "block"
    });
    const { result, event } = await harness.exec("unknown-program --flag");

    assert.ok(result.requireApproval);
    assert.equal(event.policyDecision, "require_approval");
    assert.equal(event.enforcementAction, "request_approval");
    assert.equal(event.judgeFallbackUsed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("C3 still enforces a regular judge block verdict", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ollamaResponse("block");

  try {
    const harness = createHarness({
      mode: "enforce",
      judge: { enabled: true, fallbackDecision: "require_approval" },
      hitl: { enabled: true },
      escalateFallback: "block"
    });
    const { result, event } = await harness.exec("unknown-program --flag");

    assert.deepEqual(result, { block: true });
    assert.equal(event.policyDecision, "block");
    assert.equal(event.enforcementAction, "block");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("C3 routes a judge failure to HITL when configured explicitly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("judge unavailable");
  };

  try {
    const harness = createHarness({
      mode: "enforce",
      judge: { enabled: true, fallbackDecision: "require_approval" },
      hitl: { enabled: true },
      escalateFallback: "block"
    });
    const { result, event } = await harness.exec("unknown-program --flag");

    assert.ok(result.requireApproval);
    assert.equal(event.policyDecision, "require_approval");
    assert.equal(event.enforcementAction, "request_approval");
    assert.equal(event.judgeFallbackUsed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
