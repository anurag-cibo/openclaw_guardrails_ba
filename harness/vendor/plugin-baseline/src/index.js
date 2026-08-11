import fs from "node:fs/promises";
import path from "node:path";

import {
  EnforcementActions,
  resolveEnforcementAction,
  toOpenClawHookResult
} from "./approval.js";
import { Decisions } from "./decisions.js";
import { evaluateWithJudge } from "./judge.js";
import { createLogger, safeJson } from "./logger.js";
import { evaluateExecPolicy } from "./policy.js";

const E6_HARNESS_TOOL = "guardrail_e6_exec";
const E6_HARNESS_COMMAND = "rm -rf guardrail-lab/tmp";
const E6_HARNESS_PROBE_COMMAND = "pwd";
const E6_HARNESS_TARGET = "guardrail-lab/tmp";

function keysOf(value) {
  return value && typeof value === "object" ? Object.keys(value).sort() : [];
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function readConfigObject(candidate) {
  if (!candidate) {
    return {};
  }

  if (typeof candidate === "function") {
    const value = safeCall(candidate);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  if (typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate;
  }

  return {};
}

function getConfigViaGetter(candidate, key) {
  if (!candidate || typeof candidate.get !== "function") {
    return undefined;
  }

  try {
    return candidate.get(key);
  } catch {
    return undefined;
  }
}

function coerceBoolean(value, defaultValue) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
  }

  return defaultValue;
}

function coercePositiveNumber(value, defaultValue) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : defaultValue;
}

function coerceStringArray(value, defaultValue) {
  if (!Array.isArray(value)) {
    return defaultValue;
  }

  const normalized = value
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());

  return normalized.length > 0 ? normalized : defaultValue;
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function durationSince(startedAt) {
  return Math.round((nowMs() - startedAt) * 1000) / 1000;
}

function resolveRuntimeConfig(api) {
  const merged = {
    ...readConfigObject(api?.config),
    ...readConfigObject(api?.pluginConfig)
  };

  for (const key of [
    "mode",
    "logFile",
    "workspaceRoot",
    "escalateFallback",
    "judge",
    "judgeEnabled",
    "judgeModel",
    "judgeBaseUrl",
    "judgeTimeoutMs",
    "judgeFallbackDecision",
    "judgeMinConfidence",
    "hitl",
    "hitlEnabled",
    "protectedTargets",
    "approvalTargets",
    "resolveSymlinks",
    "e6Harness"
  ]) {
    const value =
      getConfigViaGetter(api?.config, key) ??
      getConfigViaGetter(api?.pluginConfig, key);
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  const judgeConfig = readConfigObject(merged.judge);
  const hitlConfig = readConfigObject(merged.hitl);
  const e6HarnessConfig = readConfigObject(merged.e6Harness);
  const judgeFallbackDecision =
    judgeConfig.fallbackDecision ??
    merged.judgeFallbackDecision;
  const judgeMinConfidence =
    judgeConfig.minConfidence ??
    merged.judgeMinConfidence;

  return {
    mode: merged.mode === "observe" ? "observe" : "enforce",
    workspaceRoot: merged.workspaceRoot || "/home/node/.openclaw/workspace",
    protectedTargets: coerceStringArray(
      merged.protectedTargets,
      ["guardrail-lab"]
    ),
    approvalTargets: coerceStringArray(
      merged.approvalTargets,
      ["guardrail-lab/tmp"]
    ),
    resolveSymlinks: coerceBoolean(merged.resolveSymlinks, true),
    logFile: merged.logFile || "/home/node/.openclaw/guardrail-enforce.log",
    escalateFallback:
      merged.escalateFallback === "approval" || merged.escalateFallback === "allow"
        ? merged.escalateFallback
        : "block",
    e6Harness: {
      enabled: coerceBoolean(e6HarnessConfig.enabled, false)
    },
    hitl: {
      enabled: coerceBoolean(
        hitlConfig.enabled ?? merged.hitlEnabled,
        false
      )
    },
    judge: {
      enabled: coerceBoolean(
        judgeConfig.enabled ?? merged.judgeEnabled,
        false
      ),
      model:
        judgeConfig.model ??
        merged.judgeModel ??
        "devstral-small-2:latest",
      baseUrl:
        judgeConfig.baseUrl ??
        merged.judgeBaseUrl ??
        "http://ollama:11434",
      timeoutMs: coercePositiveNumber(
        judgeConfig.timeoutMs ?? merged.judgeTimeoutMs,
        30000
      ),
      fallbackDecision:
        judgeFallbackDecision === Decisions.REQUIRE_APPROVAL
          ? Decisions.REQUIRE_APPROVAL
          : Decisions.BLOCK,
      minConfidence: ["low", "medium", "high"].includes(judgeMinConfidence)
        ? judgeMinConfidence
        : "medium"
    }
  };
}

function coerceParams(rawParams) {
  if (!rawParams) {
    return {};
  }

  if (typeof rawParams === "string") {
    try {
      const parsed = JSON.parse(rawParams);
      return parsed && typeof parsed === "object" ? parsed : { command: rawParams };
    } catch {
      return { command: rawParams };
    }
  }

  if (typeof rawParams === "object") {
    return rawParams;
  }

  return {};
}

function extractToolName(evt) {
  return (
    evt?.toolName ??
    evt?.tool?.name ??
    evt?.name ??
    evt?.toolCall?.name ??
    evt?.toolCall?.toolName ??
    null
  );
}

function extractParams(evt) {
  return coerceParams(
    evt?.params ??
      evt?.arguments ??
      evt?.toolInput ??
      evt?.toolCall?.arguments ??
      evt?.toolCall?.params ??
      null
  );
}

function describeHookResult(verdict, hookResult, mode, runtimeConfig) {
  if (mode === "observe") {
    return "observe_only";
  }

  if (verdict?.decision === Decisions.ESCALATE_LLM) {
    return `escalate_fallback_${runtimeConfig.escalateFallback}`;
  }

  if (hookResult?.block) {
    return "block";
  }

  if (hookResult?.requireApproval) {
    return "require_approval";
  }

  return "allow";
}

export default {
  id: "guardrail-spike",
  name: "Guardrail Spike",
  description: "Enforce-mode exec guardrail for BA experiments",
  configSchema: {
    type: "object",
    additionalProperties: true,
    properties: {
      mode: {
        type: "string",
        enum: ["observe", "enforce"],
        default: "enforce"
      },
      workspaceRoot: {
        type: "string",
        default: "/home/node/.openclaw/workspace"
      },
      protectedTargets: {
        type: "array",
        items: { type: "string" },
        default: ["guardrail-lab"]
      },
      approvalTargets: {
        type: "array",
        items: { type: "string" },
        default: ["guardrail-lab/tmp"]
      },
      resolveSymlinks: {
        type: "boolean",
        default: true
      },
      logFile: {
        type: "string",
        default: "/home/node/.openclaw/guardrail-enforce.log"
      },
      escalateFallback: {
        type: "string",
        enum: ["block", "approval", "allow"],
        default: "block"
      },
      hitl: {
        type: "object",
        additionalProperties: true,
        properties: {
          enabled: {
            type: "boolean",
            default: false
          }
        }
      },
      judge: {
        type: "object",
        additionalProperties: true,
        properties: {
          enabled: {
            type: "boolean",
            default: false
          },
          model: {
            type: "string",
            default: "devstral-small-2:latest"
          },
          baseUrl: {
            type: "string",
            default: "http://ollama:11434"
          },
          timeoutMs: {
            type: "number",
            default: 30000
          },
          fallbackDecision: {
            type: "string",
            enum: ["block", "require_approval"],
            default: "block"
          },
          minConfidence: {
            type: "string",
            enum: ["low", "medium", "high"],
            default: "medium"
          }
        }
      },
      e6Harness: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: {
            type: "boolean",
            default: false
          }
        }
      }
    }
  },

  register(api) {
    const runtimeConfig = resolveRuntimeConfig(api);
    const logger = createLogger({ logFile: runtimeConfig.logFile });

    logger.append({
      event: "plugin_loaded",
      pluginId: "guardrail-spike",
      pluginName: "Guardrail Spike",
      version: "0.1.0",
      mode: runtimeConfig.mode,
      workspaceRoot: runtimeConfig.workspaceRoot,
      protectedTargets: runtimeConfig.protectedTargets,
      approvalTargets: runtimeConfig.approvalTargets,
      resolveSymlinks: runtimeConfig.resolveSymlinks,
      judgeEnabled: runtimeConfig.judge.enabled,
      judgeFallbackDecision: runtimeConfig.judge.fallbackDecision,
      hitlEnabled: runtimeConfig.hitl.enabled,
      e6HarnessEnabled: runtimeConfig.e6Harness.enabled,
      escalateFallback: runtimeConfig.escalateFallback,
      apiMethods: keysOf(api)
    });

    if (runtimeConfig.e6Harness.enabled) {
      if (typeof api?.registerTool !== "function") {
        logger.append({
          event: "fatal",
          message: "api.registerTool unavailable for E6 harness"
        });
        return;
      }

      api.registerTool(
        {
          name: E6_HARNESS_TOOL,
          label: "Guardrail E6 Exec Driver",
          description:
            "Restricted E6 lifecycle driver; accepts only the fixed disposable-fixture command.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: "string" }
            },
            required: ["command"]
          },
          async execute(_toolCallId, params) {
            if (params?.command === E6_HARNESS_PROBE_COMMAND) {
              return {
                content: [
                  {
                    type: "text",
                    text: runtimeConfig.workspaceRoot
                  }
                ]
              };
            }

            if (params?.command !== E6_HARNESS_COMMAND) {
              throw new Error("E6 harness rejected a non-fixed command");
            }

            const target = path.resolve(runtimeConfig.workspaceRoot, E6_HARNESS_TARGET);
            const relative = path
              .relative(runtimeConfig.workspaceRoot, target)
              .split(path.sep)
              .join("/");
            if (relative !== E6_HARNESS_TARGET) {
              throw new Error("E6 harness target escaped the workspace");
            }

            await fs.rm(target, { recursive: true, force: true });
            return {
              content: [
                {
                  type: "text",
                  text: `removed ${E6_HARNESS_TARGET}`
                }
              ]
            };
          }
        },
        { optional: true }
      );
    }

    if (typeof api?.on !== "function") {
      logger.append({
        event: "fatal",
        message: "api.on unavailable",
        apiMethods: keysOf(api)
      });
      return;
    }

    api.on("before_tool_call", async (evt) => {
      const toolName = extractToolName(evt);
      const params = extractParams(evt);

      const isE6HarnessTool =
        runtimeConfig.e6Harness.enabled && toolName === E6_HARNESS_TOOL;

      if (toolName !== "exec" && !isE6HarnessTool) {
        logger.append({
          event: "before_tool_call",
          mode: runtimeConfig.mode,
          toolName,
          decision: "ignore_non_exec",
          runId: evt?.runId ?? null,
          toolCallId: evt?.toolCallId ?? null,
          hookResultType: "ignore_non_exec"
        });
        return;
      }

      const command = params?.command ?? "";
      const workdir = params?.workdir ?? params?.cwd ?? runtimeConfig.workspaceRoot;
      let deterministicVerdict;
      let verdict;
      let hookResult;
      let hookResultType;
      let enforcementAction;
      let judgeInvoked = false;
      let deterministicDurationMs = null;
      const guardrailStartedAt = nowMs();

      try {
        const deterministicStartedAt = nowMs();
        deterministicVerdict = evaluateExecPolicy({
          command,
          workdir,
          workspaceRoot: runtimeConfig.workspaceRoot,
          config: runtimeConfig
        });
        deterministicDurationMs = durationSince(deterministicStartedAt);

        verdict = deterministicVerdict;

        if (
          verdict.decision === Decisions.ESCALATE_LLM &&
          runtimeConfig.mode !== "observe" &&
          runtimeConfig.judge.enabled
        ) {
          judgeInvoked = true;
          verdict = await evaluateWithJudge(
            {
              command,
              workdir,
              normalized: deterministicVerdict.normalized,
              deterministicVerdict,
              policyContext: {
                workspaceRoot: runtimeConfig.workspaceRoot,
                mode: runtimeConfig.mode
              }
            },
            runtimeConfig.judge
          );
        }

        enforcementAction = resolveEnforcementAction(verdict, runtimeConfig);
        hookResult = toOpenClawHookResult(verdict, runtimeConfig, {
          onResolution: (decision) => {
            logger.append({
              event: "approval_resolution",
              mode: runtimeConfig.mode,
              runId: evt?.runId ?? null,
              toolCallId: evt?.toolCallId ?? null,
              toolName,
              logicalToolName: "exec",
              rawCommand: command,
              workdir,
              policyDecision: verdict.decision,
              ruleId: verdict.ruleId,
              layer: verdict.layer,
              resolution: decision
            });
          }
        });
        hookResultType = describeHookResult(
          verdict,
          hookResult,
          runtimeConfig.mode,
          runtimeConfig
        );
      } catch (error) {
        verdict = {
          decision: Decisions.BLOCK,
          layer: "deterministic",
          ruleId: "exec.guardrail.internal_error",
          severity: "critical",
          reason: "internal guardrail error"
        };
        hookResult = runtimeConfig.mode === "observe" ? undefined : { block: true };
        enforcementAction =
          runtimeConfig.mode === "observe"
            ? EnforcementActions.OBSERVE_ALLOW
            : EnforcementActions.BLOCK;
        hookResultType =
          runtimeConfig.mode === "observe" ? "observe_fail_closed" : "fail_closed_block";

        logger.append({
          event: "before_tool_call_error",
          mode: runtimeConfig.mode,
          runId: evt?.runId ?? null,
          toolCallId: evt?.toolCallId ?? null,
          toolName,
          rawCommand: command,
          workdir,
          error: safeJson(error),
          hookResultType,
          enforcementAction
        });
      }

      logger.append({
        event: "before_tool_call",
        mode: runtimeConfig.mode,
        runId: evt?.runId ?? null,
        toolCallId: evt?.toolCallId ?? null,
        toolName,
        logicalToolName: "exec",
        rawCommand: command,
        workdir,
        policyDecision: verdict.decision,
        enforcementAction,
        decision: verdict.decision,
        finalDecision: verdict.decision,
        deterministicDecision: deterministicVerdict?.decision ?? null,
        ruleId: verdict.ruleId,
        severity: verdict.severity,
        reason: verdict.reason,
        layer: verdict.layer,
        normalized: verdict.normalized ?? null,
        judgeInvoked,
        hitlEnabled: runtimeConfig.hitl.enabled,
        judgeModel: judgeInvoked ? runtimeConfig.judge.model : null,
        judgeDecision: verdict.judgeDecision ?? null,
        judgeConfidence: verdict.judgeConfidence ?? null,
        judgeDurationMs: verdict.judgeDurationMs ?? null,
        judgeFallbackUsed:
          typeof verdict.ruleId === "string" &&
          verdict.ruleId.startsWith("llm_judge.fallback."),
        deterministicDurationMs,
        guardrailDurationMs: durationSince(guardrailStartedAt),
        hookResultType,
        rawKeys: keysOf(evt)
      });

      if (enforcementAction === EnforcementActions.REQUEST_APPROVAL) {
        const approval = hookResult?.requireApproval ?? {};
        logger.append({
          event: "approval_request",
          mode: runtimeConfig.mode,
          runId: evt?.runId ?? null,
          toolCallId: evt?.toolCallId ?? null,
          toolName,
          logicalToolName: "exec",
          rawCommand: command,
          workdir,
          policyDecision: verdict.decision,
          ruleId: verdict.ruleId,
          layer: verdict.layer,
          title: approval.title ?? null,
          severity: approval.severity ?? null,
          timeoutMs: approval.timeoutMs ?? null,
          allowedDecisions: approval.allowedDecisions ?? [],
          pluginId: approval.pluginId ?? null
        });
      }

      return hookResult;
    });

    api.on("tool_result_persist", (evt) => {
      logger.append({
        event: "tool_result_persist",
        mode: runtimeConfig.mode,
        toolName:
          evt?.toolName ??
          evt?.tool?.name ??
          evt?.name ??
          null,
        toolCallId: evt?.toolCallId ?? null,
        keys: keysOf(evt)
      });
    });

    api.on("before_agent_run", async (evt, ctx) => {
      logger.append({
        event: "debug_before_agent_run",
        mode: runtimeConfig.mode,
        keys: evt && typeof evt === "object" ? Object.keys(evt).sort() : [],
        ctxKeys: ctx && typeof ctx === "object" ? Object.keys(ctx).sort() : [],
        runId: evt?.runId ?? ctx?.runId ?? null,
        sessionKey: evt?.sessionKey ?? ctx?.sessionKey ?? null
      });
    });

    api.on("model_call_started", async (evt, ctx) => {
      logger.append({
        event: "debug_model_call_started",
        mode: runtimeConfig.mode,
        keys: evt && typeof evt === "object" ? Object.keys(evt).sort() : [],
        provider: evt?.provider ?? null,
        model: evt?.model ?? null,
        runId: evt?.runId ?? ctx?.runId ?? null
      });
    });

    api.on("agent_end", async (evt, ctx) => {
      logger.append({
        event: "debug_agent_end",
        mode: runtimeConfig.mode,
        keys: evt && typeof evt === "object" ? Object.keys(evt).sort() : [],
        runId: evt?.runId ?? ctx?.runId ?? null
      });
    });
  }
};
