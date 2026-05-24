import { toOpenClawHookResult } from "./approval.js";
import { Decisions } from "./decisions.js";
import { createLogger, safeJson } from "./logger.js";
import { evaluateExecPolicy } from "./policy.js";

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

function resolveRuntimeConfig(api) {
  const merged = {
    ...readConfigObject(api?.config),
    ...readConfigObject(api?.pluginConfig)
  };

  for (const key of ["mode", "logFile", "workspaceRoot", "escalateFallback"]) {
    const value =
      getConfigViaGetter(api?.config, key) ??
      getConfigViaGetter(api?.pluginConfig, key);
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return {
    mode: merged.mode === "observe" ? "observe" : "enforce",
    workspaceRoot: merged.workspaceRoot || "/home/node/.openclaw/workspace",
    logFile: merged.logFile || "/home/node/.openclaw/guardrail-enforce.log",
    escalateFallback:
      merged.escalateFallback === "approval" || merged.escalateFallback === "allow"
        ? merged.escalateFallback
        : "block"
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
      logFile: {
        type: "string",
        default: "/home/node/.openclaw/guardrail-enforce.log"
      },
      escalateFallback: {
        type: "string",
        enum: ["block", "approval", "allow"],
        default: "block"
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
      apiMethods: keysOf(api)
    });

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

      if (toolName !== "exec") {
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
      let verdict;
      let hookResult;
      let hookResultType;

      try {
        verdict = evaluateExecPolicy({
          command,
          workdir,
          workspaceRoot: runtimeConfig.workspaceRoot,
          config: runtimeConfig
        });
        hookResult =
          runtimeConfig.mode === "observe"
            ? undefined
            : toOpenClawHookResult(verdict, runtimeConfig);
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
          hookResultType
        });
      }

      logger.append({
        event: "before_tool_call",
        mode: runtimeConfig.mode,
        runId: evt?.runId ?? null,
        toolCallId: evt?.toolCallId ?? null,
        toolName,
        rawCommand: command,
        workdir,
        decision: verdict.decision,
        ruleId: verdict.ruleId,
        severity: verdict.severity,
        reason: verdict.reason,
        layer: verdict.layer,
        normalized: verdict.normalized ?? null,
        hookResultType,
        rawKeys: keysOf(evt)
      });

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
