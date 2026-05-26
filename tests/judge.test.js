import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWithJudge,
  mapJudgeOutputToDecision,
  parseJudgeJson
} from "../src/judge.js";
import { Decisions } from "../src/decisions.js";

const deterministicVerdict = {
  decision: Decisions.ESCALATE_LLM,
  ruleId: "exec.unknown.escalate",
  severity: "medium",
  reason: "unknown command is not deterministically safe",
  normalized: {
    rawCommand: "foobar --do-something",
    targetCanonicals: []
  },
  targetCanonicals: []
};

function responseWithJudgeOutput(output) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        message: {
          content: typeof output === "string" ? output : JSON.stringify(output)
        }
      });
    }
  };
}

async function evaluateWithMockedOutput(output, config = {}) {
  return evaluateWithJudge(
    {
      command: "foobar --do-something",
      workdir: "/home/node/.openclaw/workspace",
      normalized: deterministicVerdict.normalized,
      deterministicVerdict,
      policyContext: {
        workspaceRoot: "/home/node/.openclaw/workspace"
      }
    },
    {
      ...config,
      fetchImpl: async () => responseWithJudgeOutput(output)
    }
  );
}

test("parseJudgeJson parses valid JSON content", () => {
  assert.deepEqual(
    parseJudgeJson(
      '{"decision":"block","confidence":"high","riskCategory":"destructive","reason":"dangerous"}'
    ),
    {
      decision: "block",
      confidence: "high",
      riskCategory: "destructive",
      reason: "dangerous"
    }
  );
});

test("invalid JSON maps to fallback block through evaluateWithJudge", async () => {
  const verdict = await evaluateWithMockedOutput("{not json");

  assert.equal(verdict.decision, Decisions.BLOCK);
  assert.equal(verdict.layer, "llm_judge");
  assert.match(verdict.judgeReason, /failed|JSON|Unexpected/i);
});

test("unknown judge decision maps to fallback block", () => {
  const verdict = mapJudgeOutputToDecision(
    {
      decision: "escalate_llm",
      confidence: "high",
      riskCategory: "unknown",
      reason: "not allowed"
    },
    {
      deterministicVerdict,
      config: { fallbackDecision: "block" },
      judgeDurationMs: 1
    }
  );

  assert.equal(verdict.decision, Decisions.BLOCK);
  assert.equal(verdict.judgeDecision, "escalate_llm");
});

test("fetch error maps to fallback block", async () => {
  const verdict = await evaluateWithJudge(
    {
      command: "foobar --do-something",
      deterministicVerdict
    },
    {
      fetchImpl: async () => {
        throw new Error("network unavailable");
      }
    }
  );

  assert.equal(verdict.decision, Decisions.BLOCK);
  assert.match(verdict.judgeReason, /network unavailable/);
});

test("timeout maps to fallback block", async () => {
  const verdict = await evaluateWithJudge(
    {
      command: "foobar --do-something",
      deterministicVerdict
    },
    {
      timeoutMs: 1,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    }
  );

  assert.equal(verdict.decision, Decisions.BLOCK);
  assert.match(verdict.judgeReason, /timed out/);
});

test("high-confidence allow maps to allow", async () => {
  const verdict = await evaluateWithMockedOutput({
    decision: "allow",
    confidence: "high",
    riskCategory: "readonly",
    reason: "readonly inspection"
  });

  assert.equal(verdict.decision, Decisions.ALLOW);
  assert.equal(verdict.layer, "llm_judge");
  assert.equal(verdict.judgeConfidence, "high");
  assert.equal(verdict.deterministicRuleId, deterministicVerdict.ruleId);
});

test("medium-confidence require_approval maps to require_approval", async () => {
  const verdict = await evaluateWithMockedOutput({
    decision: "require_approval",
    confidence: "medium",
    riskCategory: "workspace_write",
    reason: "workspace mutation should be approved"
  });

  assert.equal(verdict.decision, Decisions.REQUIRE_APPROVAL);
  assert.equal(verdict.judgeRiskCategory, "workspace_write");
});

test("high-confidence block maps to block", async () => {
  const verdict = await evaluateWithMockedOutput({
    decision: "block",
    confidence: "high",
    riskCategory: "destructive",
    reason: "destructive command"
  });

  assert.equal(verdict.decision, Decisions.BLOCK);
  assert.equal(verdict.judgeDecision, "block");
});

test("allow below minConfidence falls back fail-closed", async () => {
  const verdict = await evaluateWithMockedOutput(
    {
      decision: "allow",
      confidence: "medium",
      riskCategory: "readonly",
      reason: "maybe safe"
    },
    {
      minConfidence: "high"
    }
  );

  assert.equal(verdict.decision, Decisions.BLOCK);
  assert.equal(verdict.judgeDecision, "allow");
});

test("low confidence can fall back to require_approval when configured", async () => {
  const verdict = await evaluateWithMockedOutput(
    {
      decision: "allow",
      confidence: "low",
      riskCategory: "unknown",
      reason: "uncertain"
    },
    {
      fallbackDecision: "require_approval"
    }
  );

  assert.equal(verdict.decision, Decisions.REQUIRE_APPROVAL);
  assert.equal(verdict.judgeConfidence, "low");
});
