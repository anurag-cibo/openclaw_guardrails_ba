import { Decisions, fromJudgeDecision } from "./decisions.js";

const DEFAULT_MODEL = "devstral-small-2:latest";
const DEFAULT_BASE_URL = "http://ollama:11434";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_FALLBACK_DECISION = Decisions.BLOCK;
const DEFAULT_MIN_CONFIDENCE = "medium";
const CONFIDENCE_RANK = {
  low: 1,
  medium: 2,
  high: 3
};
const JUDGE_DECISIONS = new Set([
  Decisions.ALLOW,
  Decisions.REQUIRE_APPROVAL,
  Decisions.BLOCK
]);
const RISK_CATEGORIES = new Set([
  "readonly",
  "workspace_write",
  "outside_workspace",
  "interpreter_eval",
  "network",
  "unknown",
  "destructive"
]);

function nowMs() {
  if (globalThis.performance?.now) {
    return globalThis.performance.now();
  }

  return Date.now();
}

function durationSince(startedAt) {
  return Math.round((nowMs() - startedAt) * 1000) / 1000;
}

function normalizeJudgeConfig(config = {}) {
  return {
    model: typeof config.model === "string" && config.model
      ? config.model
      : DEFAULT_MODEL,
    baseUrl: typeof config.baseUrl === "string" && config.baseUrl
      ? config.baseUrl.replace(/\/+$/u, "")
      : DEFAULT_BASE_URL,
    timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS,
    fallbackDecision:
      config.fallbackDecision === Decisions.REQUIRE_APPROVAL
        ? Decisions.REQUIRE_APPROVAL
        : DEFAULT_FALLBACK_DECISION,
    minConfidence: CONFIDENCE_RANK[config.minConfidence]
      ? config.minConfidence
      : DEFAULT_MIN_CONFIDENCE,
    fetchImpl: config.fetchImpl
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify(String(value));
  }
}

function systemPrompt() {
  return [
    "You are an OpenClaw exec tool guardrail judge.",
    "You only review commands that the deterministic policy marked as escalate_llm.",
    "Return exactly one JSON object and no markdown.",
    "Allowed decisions are allow, require_approval, and block.",
    "Never return escalate_llm.",
    "Use allow only when the command is clearly safe and non-destructive.",
    "Use require_approval when a human should confirm a workspace-scoped side effect.",
    "Use block for destructive, exfiltration, outside-workspace, or unclear risk."
  ].join("\n");
}

function userPrompt(input) {
  return [
    "Evaluate this exec tool call.",
    "Return JSON with this schema:",
    '{"decision":"allow|require_approval|block","confidence":"low|medium|high","riskCategory":"readonly|workspace_write|outside_workspace|interpreter_eval|network|unknown|destructive","reason":"short explanation"}',
    "",
    safeJson({
      command: input?.command ?? null,
      workdir: input?.workdir ?? null,
      normalized: input?.normalized ?? null,
      deterministicVerdict: input?.deterministicVerdict ?? null,
      policyContext: input?.policyContext ?? null
    })
  ].join("\n");
}

function fallbackJudgeDecision({
  deterministicVerdict,
  judgeModel,
  judgeDurationMs,
  fallbackDecision,
  judgeReason,
  judgeDecision = "fallback",
  judgeConfidence = "low",
  judgeRiskCategory = "unknown"
}) {
  const decision =
    fallbackDecision === Decisions.REQUIRE_APPROVAL
      ? Decisions.REQUIRE_APPROVAL
      : Decisions.BLOCK;
  const reason =
    decision === Decisions.REQUIRE_APPROVAL
      ? "LLM judge unavailable or uncertain; human approval required"
      : "LLM judge unavailable or uncertain; blocked fail-closed";

  return fromJudgeDecision(decision, reason, {
    ruleId: `llm_judge.fallback.${decision}`,
    judgeModel,
    judgeDecision,
    judgeConfidence,
    judgeReason,
    judgeRiskCategory,
    judgeDurationMs,
    deterministicRuleId: deterministicVerdict?.ruleId ?? null,
    deterministicDecision: deterministicVerdict?.decision ?? null,
    normalized: deterministicVerdict?.normalized ?? null,
    targetCanonicals: deterministicVerdict?.targetCanonicals ?? [],
    riskCategory: judgeRiskCategory
  });
}

export function parseJudgeJson(content) {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content;
  }

  if (typeof content !== "string") {
    throw new Error("judge response content is not a string");
  }

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("judge response content is empty");
  }

  return JSON.parse(trimmed);
}

export function parseOllamaChatResponse(bodyText) {
  const body = JSON.parse(bodyText);
  return parseJudgeJson(body?.message?.content ?? body?.response ?? body);
}

export function mapJudgeOutputToDecision(output, context = {}) {
  const config = normalizeJudgeConfig(context.config);
  const startedAt = context.startedAt ?? nowMs();
  const judgeDurationMs = context.judgeDurationMs ?? durationSince(startedAt);
  const deterministicVerdict = context.deterministicVerdict;
  const judgeDecision = output?.decision;
  const judgeConfidence = output?.confidence;
  const judgeRiskCategory = RISK_CATEGORIES.has(output?.riskCategory)
    ? output.riskCategory
    : "unknown";
  const judgeReason =
    typeof output?.reason === "string" && output.reason.trim()
      ? output.reason.trim()
      : "No judge reason provided";

  if (!JUDGE_DECISIONS.has(judgeDecision)) {
    return fallbackJudgeDecision({
      deterministicVerdict,
      judgeModel: config.model,
      judgeDurationMs,
      fallbackDecision: config.fallbackDecision,
      judgeReason: `Invalid judge decision: ${String(judgeDecision)}`,
      judgeDecision: String(judgeDecision ?? "invalid"),
      judgeConfidence: String(judgeConfidence ?? "low"),
      judgeRiskCategory
    });
  }

  if (!CONFIDENCE_RANK[judgeConfidence]) {
    return fallbackJudgeDecision({
      deterministicVerdict,
      judgeModel: config.model,
      judgeDurationMs,
      fallbackDecision: config.fallbackDecision,
      judgeReason: `Invalid judge confidence: ${String(judgeConfidence)}`,
      judgeDecision,
      judgeConfidence: String(judgeConfidence ?? "low"),
      judgeRiskCategory
    });
  }

  if (judgeConfidence === "low") {
    return fallbackJudgeDecision({
      deterministicVerdict,
      judgeModel: config.model,
      judgeDurationMs,
      fallbackDecision: config.fallbackDecision,
      judgeReason,
      judgeDecision,
      judgeConfidence,
      judgeRiskCategory
    });
  }

  if (
    judgeDecision === Decisions.ALLOW &&
    CONFIDENCE_RANK[judgeConfidence] < CONFIDENCE_RANK[config.minConfidence]
  ) {
    return fallbackJudgeDecision({
      deterministicVerdict,
      judgeModel: config.model,
      judgeDurationMs,
      fallbackDecision: config.fallbackDecision,
      judgeReason: `Allow confidence ${judgeConfidence} below minimum ${config.minConfidence}: ${judgeReason}`,
      judgeDecision,
      judgeConfidence,
      judgeRiskCategory
    });
  }

  return fromJudgeDecision(judgeDecision, judgeReason, {
    ruleId: `llm_judge.${judgeDecision}`,
    judgeModel: config.model,
    judgeDecision,
    judgeConfidence,
    judgeReason,
    judgeRiskCategory,
    judgeDurationMs,
    deterministicRuleId: deterministicVerdict?.ruleId ?? null,
    deterministicDecision: deterministicVerdict?.decision ?? null,
    normalized: deterministicVerdict?.normalized ?? null,
    targetCanonicals: deterministicVerdict?.targetCanonicals ?? [],
    riskCategory: judgeRiskCategory
  });
}

export async function evaluateWithJudge(input, config = {}) {
  const judgeConfig = normalizeJudgeConfig(config);
  const startedAt = nowMs();
  const fetchImpl = judgeConfig.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    return fallbackJudgeDecision({
      deterministicVerdict: input?.deterministicVerdict,
      judgeModel: judgeConfig.model,
      judgeDurationMs: durationSince(startedAt),
      fallbackDecision: judgeConfig.fallbackDecision,
      judgeReason: "fetch is not available in this runtime"
    });
  }

  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  const timeout =
    controller && Number.isFinite(judgeConfig.timeoutMs)
      ? setTimeout(() => controller.abort(), judgeConfig.timeoutMs)
      : null;

  try {
    const response = await fetchImpl(`${judgeConfig.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: judgeConfig.model,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: userPrompt(input) }
        ],
        format: "json",
        options: {
          temperature: 0
        }
      }),
      signal: controller?.signal
    });

    if (!response?.ok) {
      return fallbackJudgeDecision({
        deterministicVerdict: input?.deterministicVerdict,
        judgeModel: judgeConfig.model,
        judgeDurationMs: durationSince(startedAt),
        fallbackDecision: judgeConfig.fallbackDecision,
        judgeReason: `Ollama HTTP error: ${response?.status ?? "unknown"}`
      });
    }

    const output = parseOllamaChatResponse(await response.text());
    return mapJudgeOutputToDecision(output, {
      config: judgeConfig,
      deterministicVerdict: input?.deterministicVerdict,
      judgeDurationMs: durationSince(startedAt)
    });
  } catch (error) {
    return fallbackJudgeDecision({
      deterministicVerdict: input?.deterministicVerdict,
      judgeModel: judgeConfig.model,
      judgeDurationMs: durationSince(startedAt),
      fallbackDecision: judgeConfig.fallbackDecision,
      judgeReason: error?.name === "AbortError"
        ? "LLM judge request timed out"
        : `LLM judge request failed: ${error?.message ?? String(error)}`
    });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
