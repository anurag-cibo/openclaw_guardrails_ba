import { Decisions } from "./decisions.js";

export function toOpenClawHookResult(verdict, runtimeConfig = {}) {
  if (!verdict || verdict.decision === Decisions.ALLOW) {
    return undefined;
  }

  if (verdict.decision === Decisions.BLOCK) {
    return { block: true };
  }

  if (verdict.decision === Decisions.REQUIRE_APPROVAL) {
    return { requireApproval: true };
  }

  if (verdict.decision === Decisions.ESCALATE_LLM) {
    if (runtimeConfig.escalateFallback === "approval") {
      return { requireApproval: true };
    }

    if (runtimeConfig.escalateFallback === "allow") {
      return undefined;
    }

    return { block: true };
  }

  return { block: true };
}
