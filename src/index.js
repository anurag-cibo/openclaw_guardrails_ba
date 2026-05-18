import fs from "node:fs";

const LOG_FILE = "/home/node/.openclaw/guardrail-enforce.log";

function keysOf(value) {
  return value && typeof value === "object" ? Object.keys(value).sort() : [];
}

function safe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function append(entry) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry
  });
  fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
}

function normalizeCommand(command) {
  return String(command || "").trim().replace(/\s+/g, " ");
}

function classifyExec(command) {
  const cmd = normalizeCommand(command);

  if (!cmd) {
    return {
      decision: "allow",
      severity: "none",
      ruleId: "exec.empty",
      reason: "empty command"
    };
  }

  if (/^(pwd|ls(\s|$)|grep(\s|$)|find(\s|$)|git status$|pytest(\s|$)|npm test$)/.test(cmd)) {
    return {
      decision: "allow",
      severity: "low",
      ruleId: "exec.safe.readonly",
      reason: "known benign workspace command"
    };
  }

  if (/^rm\s+-rf\s+guardrail-lab\/tmp\/?$/.test(cmd)) {
    return {
      decision: "require_approval",
      severity: "medium",
      ruleId: "exec.delete.medium.lab-subdir",
      reason: "recursive deletion of lab subdirectory"
    };
  }

  if (/^rm\s+-rf\s+guardrail-lab\/?$/.test(cmd)) {
    return {
      decision: "block",
      severity: "high",
      ruleId: "exec.delete.high.lab-root",
      reason: "recursive deletion of lab root"
    };
  }

  if (
    /^rm\s+-rf\s+\/($|\s)/.test(cmd) ||
    /\bshutdown\b/.test(cmd) ||
    /\breboot\b/.test(cmd) ||
    /\bmkfs\b/.test(cmd) ||
    /\bdd\s+if=/.test(cmd) ||
    /\bchmod\s+-R\b/.test(cmd) ||
    /\bchown\s+-R\b/.test(cmd) ||
    /\bkillall\b/.test(cmd)
  ) {
    return {
      decision: "block",
      severity: "critical",
      ruleId: "exec.destructive.critical",
      reason: "critical destructive pattern"
    };
  }

  return {
    decision: "allow",
    severity: "unknown",
    ruleId: "exec.default.allow",
    reason: "no matching risky pattern"
  };
}

export default {
  id: "guardrail-spike",
  name: "Guardrail Spike",
  description: "Enforce-mode exec guardrail for BA experiments",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {}
  },

  register(api) {
    append({
      event: "plugin_loaded",
      mode: "enforce",
      apiMethods: keysOf(api)
    });

    if (typeof api?.on !== "function") {
      append({
        event: "fatal",
        message: "api.on unavailable",
        apiMethods: keysOf(api)
      });
      return;
    }

    api.on("before_tool_call", async (evt) => {
      const toolName =
        evt?.toolName ??
        evt?.tool?.name ??
        evt?.name ??
        evt?.toolCall?.name ??
        null;

      const params = safe(
        evt?.params ??
        evt?.arguments ??
        evt?.toolInput ??
        evt?.toolCall?.arguments ??
        null
      );

      if (toolName !== "exec") {
        append({
          event: "before_tool_call",
          mode: "enforce",
          toolName,
          decision: "ignore_non_exec",
          runId: evt?.runId ?? null,
          toolCallId: evt?.toolCallId ?? null
        });
        return;
      }

      const command = params?.command ?? "";
      const workdir = params?.workdir ?? "";
      const verdict = classifyExec(command);

      append({
        event: "before_tool_call",
        mode: "enforce",
        toolName,
        runId: evt?.runId ?? null,
        toolCallId: evt?.toolCallId ?? null,
        command,
        workdir,
        decision: verdict.decision,
        severity: verdict.severity,
        ruleId: verdict.ruleId,
        reason: verdict.reason,
        rawKeys: keysOf(evt)
      });

      if (verdict.decision === "block") {
        return { block: true };
      }

      if (verdict.decision === "require_approval") {
        return { requireApproval: true };
      }

      return;
    });

    api.on("tool_result_persist", (evt) => {
      append({
        event: "tool_result_persist",
        mode: "enforce",
        toolName:
          evt?.toolName ??
          evt?.tool?.name ??
          evt?.name ??
          null,
        toolCallId: evt?.toolCallId ?? null,
        keys: keysOf(evt)
      });
    });
  }
};
