import { Decisions } from "./decisions.js";

const DEFAULT_PLUGIN_ID = "guardrail-spike";
const DEFAULT_APPROVAL_TIMEOUT_MS = 60000;
const DEFAULT_ALLOWED_DECISIONS = ["allow-once", "deny"];

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

function buildRequireApprovalResult(verdict) {
  return {
    requireApproval: {
      title: "Guardrail approval required",
      description: buildApprovalDescription(verdict),
      severity: mapApprovalSeverity(verdict?.severity),
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      timeoutBehavior: "deny",
      allowedDecisions: DEFAULT_ALLOWED_DECISIONS,
      pluginId: DEFAULT_PLUGIN_ID
    }
  };
}

export function toOpenClawHookResult(verdict, runtimeConfig = {}) {
  if (!verdict || verdict.decision === Decisions.ALLOW) {
    return undefined;
  }

  if (verdict.decision === Decisions.BLOCK) {
    return { block: true };
  }

  if (verdict.decision === Decisions.REQUIRE_APPROVAL) {
    return buildRequireApprovalResult(verdict);
  }

  if (verdict.decision === Decisions.ESCALATE_LLM) {
    if (runtimeConfig.escalateFallback === "approval") {
      return buildRequireApprovalResult(verdict);
    }

    if (runtimeConfig.escalateFallback === "allow") {
      return undefined;
    }

    return { block: true };
  }

  return { block: true };
}
