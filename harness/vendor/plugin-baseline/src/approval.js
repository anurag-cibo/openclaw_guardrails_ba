import { Decisions } from "./decisions.js";

const DEFAULT_PLUGIN_ID = "guardrail-spike";
const DEFAULT_APPROVAL_TIMEOUT_MS = 60000;
const DEFAULT_ALLOWED_DECISIONS = ["allow-once", "deny"];

export const EnforcementActions = Object.freeze({
  OBSERVE_ALLOW: "observe_allow",
  ALLOW: "allow",
  BLOCK: "block",
  REQUEST_APPROVAL: "request_approval"
});

function mapApprovalSeverity(severity) {
  const normalizedSeverity = String(severity ?? "").toLowerCase();

  if (normalizedSeverity === "critical" || normalizedSeverity === "high") {
    return "critical";
  }

  if (normalizedSeverity === "medium") {
    return "warning";
  }

  return "info";
}

function extractCommand(verdict) {
  return (
    verdict?.command ??
    verdict?.rawCommand ??
    verdict?.normalized?.rawCommand ??
    null
  );
}

function extractTargetCanonicals(verdict) {
  if (Array.isArray(verdict?.targetCanonicals)) {
    return verdict.targetCanonicals;
  }

  if (Array.isArray(verdict?.normalized?.targetCanonicals)) {
    return verdict.normalized.targetCanonicals;
  }

  return [];
}

function buildApprovalDescription(verdict) {
  const parts = [];
  const reason = verdict?.reason ?? "Guardrail approval required";
  const command = extractCommand(verdict);
  const targetCanonicals = extractTargetCanonicals(verdict);

  parts.push(reason);

  if (command) {
    parts.push(`Command: ${command}`);
  }

  if (verdict?.ruleId) {
    parts.push(`Rule: ${verdict.ruleId}`);
  }

  if (targetCanonicals.length > 0) {
    parts.push(`Targets: ${targetCanonicals.join(", ")}`);
  }

  return parts.join("\n");
}

function buildRequireApprovalResult(verdict, approvalContext = {}) {
  const requireApproval = {
      title: "Guardrail approval required",
      description: buildApprovalDescription(verdict),
      severity: mapApprovalSeverity(verdict?.severity),
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      timeoutBehavior: "deny",
      allowedDecisions: DEFAULT_ALLOWED_DECISIONS,
      pluginId: DEFAULT_PLUGIN_ID
  };

  if (typeof approvalContext.onResolution === "function") {
    requireApproval.onResolution = approvalContext.onResolution;
  }

  return { requireApproval };
}

function isHitlEnabled(runtimeConfig) {
  return runtimeConfig?.hitl?.enabled === true;
}

export function resolveEnforcementAction(verdict, runtimeConfig = {}) {
  if (runtimeConfig.mode === "observe") {
    return EnforcementActions.OBSERVE_ALLOW;
  }

  if (!verdict || verdict.decision === Decisions.ALLOW) {
    return EnforcementActions.ALLOW;
  }

  if (verdict.decision === Decisions.BLOCK) {
    return EnforcementActions.BLOCK;
  }

  if (verdict.decision === Decisions.REQUIRE_APPROVAL) {
    return isHitlEnabled(runtimeConfig)
      ? EnforcementActions.REQUEST_APPROVAL
      : EnforcementActions.BLOCK;
  }

  if (verdict.decision === Decisions.ESCALATE_LLM) {
    if (
      runtimeConfig.escalateFallback === "approval" &&
      isHitlEnabled(runtimeConfig)
    ) {
      return EnforcementActions.REQUEST_APPROVAL;
    }

    if (runtimeConfig.escalateFallback === "allow") {
      return EnforcementActions.ALLOW;
    }

    return EnforcementActions.BLOCK;
  }

  return EnforcementActions.BLOCK;
}

export function toOpenClawHookResult(
  verdict,
  runtimeConfig = {},
  approvalContext = {}
) {
  const enforcementAction = resolveEnforcementAction(verdict, runtimeConfig);

  if (enforcementAction === EnforcementActions.BLOCK) {
    return { block: true };
  }

  if (enforcementAction === EnforcementActions.REQUEST_APPROVAL) {
    return buildRequireApprovalResult(verdict, approvalContext);
  }

  return undefined;
}
