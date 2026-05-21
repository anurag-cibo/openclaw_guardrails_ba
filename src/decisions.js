export const Decisions = {
  ALLOW: "allow",
  BLOCK: "block",
  REQUIRE_APPROVAL: "require_approval",
  ESCALATE_LLM: "escalate_llm"
};

function makeDecision(decision, defaultSeverity, ruleId, reason, extra = {}) {
  return {
    ...extra,
    decision,
    layer: "deterministic",
    ruleId,
    severity: extra.severity ?? defaultSeverity,
    reason
  };
}

export function allow(ruleId, reason, extra = {}) {
  return makeDecision(Decisions.ALLOW, "low", ruleId, reason, extra);
}

export function block(ruleId, reason, extra = {}) {
  return makeDecision(Decisions.BLOCK, "high", ruleId, reason, extra);
}

export function requireApproval(ruleId, reason, extra = {}) {
  return makeDecision(
    Decisions.REQUIRE_APPROVAL,
    "medium",
    ruleId,
    reason,
    extra
  );
}

export function escalateLlm(ruleId, reason, extra = {}) {
  return makeDecision(
    Decisions.ESCALATE_LLM,
    "medium",
    ruleId,
    reason,
    extra
  );
}
