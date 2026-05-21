import { performance } from "node:perf_hooks";
import {
  allow,
  block,
  escalateLlm,
  requireApproval
} from "./decisions.js";
import { normalizeExecCommand } from "./normalize-command.js";

const READ_FILE_PROGRAMS = new Set(["cat", "head", "tail"]);
const CRITICAL_PROGRAMS = new Set(["shutdown", "reboot", "mkfs", "killall"]);
const NETWORK_PROGRAMS = new Set(["curl", "wget", "scp", "rsync", "nc"]);
const INTERPRETERS = new Set(["python", "python3", "node", "bash", "sh"]);

function targetCanonicals(normalized) {
  return normalized.targetCanonicals ?? [];
}

function withCommonFields(verdict, normalized, startedAt) {
  return {
    ...verdict,
    normalized,
    durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    targetCanonicals: targetCanonicals(normalized)
  };
}

function hasAnyTarget(normalized, predicate) {
  return normalized.targetInfos.some(predicate);
}

function allTargetsWithinWorkspace(normalized) {
  return normalized.targetInfos.every((target) => target.isInsideWorkspace);
}

function allTargetsInsideWorkspaceOrNoTargets(normalized) {
  return normalized.targetInfos.length === 0 || allTargetsWithinWorkspace(normalized);
}

function hasAmbiguousShellInput(normalized) {
  return normalized.complexShell || normalized.hasUnsafeExpansion;
}

function isAllowedGitCommand(normalized) {
  if (normalized.programBase !== "git") {
    return false;
  }

  const subcommand = normalized.argv[1];
  return subcommand === "status" || subcommand === "diff" || subcommand === "log";
}

function isAllowedReadonlyCommand(normalized) {
  if (normalized.programBase === "pwd") {
    return normalized.targetInfos.length === 0;
  }

  if (normalized.programBase === "ls") {
    return allTargetsInsideWorkspaceOrNoTargets(normalized);
  }

  if (READ_FILE_PROGRAMS.has(normalized.programBase)) {
    return allTargetsInsideWorkspaceOrNoTargets(normalized);
  }

  if (normalized.programBase === "grep") {
    return allTargetsInsideWorkspaceOrNoTargets(normalized);
  }

  if (isAllowedGitCommand(normalized)) {
    return true;
  }

  if (normalized.programBase === "find" && normalized.operation === "find") {
    return allTargetsWithinWorkspace(normalized);
  }

  return false;
}

function recursiveDeleteDecision(normalized) {
  if (hasAnyTarget(normalized, (target) => target.isFilesystemRoot || target.isRootGlob)) {
    return block("exec.delete.root", "recursive deletion of filesystem root", {
      riskCategory: "destructive_delete",
      severity: "critical"
    });
  }

  if (hasAnyTarget(normalized, (target) => target.isWorkspaceRoot)) {
    return block("exec.delete.workspace_root", "recursive deletion of workspace root", {
      riskCategory: "destructive_delete",
      severity: "critical"
    });
  }

  if (hasAnyTarget(normalized, (target) => target.isProtectedTarget)) {
    return block(
      "exec.delete.protected_target",
      "recursive deletion of protected target",
      {
        riskCategory: "protected_target_delete",
        severity: "high"
      }
    );
  }

  if (hasAnyTarget(normalized, (target) => target.isApprovalTarget)) {
    return requireApproval(
      "exec.delete.approval_target",
      "recursive deletion of approval target",
      {
        riskCategory: "approval_target_delete",
        severity: "medium"
      }
    );
  }

  if (hasAnyTarget(normalized, (target) => target.isInsideProtectedTarget)) {
    return block(
      "exec.delete.inside_protected_target",
      "recursive deletion inside protected target",
      {
        riskCategory: "protected_target_delete",
        severity: "high"
      }
    );
  }

  if (hasAmbiguousShellInput(normalized)) {
    return escalateLlm(
      "exec.delete.ambiguous_target",
      "recursive delete target contains shell syntax or expansion",
      {
        riskCategory: "ambiguous_delete_target",
        severity: "high"
      }
    );
  }

  if (hasAnyTarget(normalized, (target) => target.isOutsideWorkspace)) {
    return block(
      "exec.delete.outside_workspace",
      "recursive deletion outside workspace",
      {
        riskCategory: "outside_workspace_delete",
        severity: "critical"
      }
    );
  }

  if (hasAnyTarget(normalized, (target) => target.isInsideWorkspace)) {
    return requireApproval(
      "exec.delete.workspace_subtree",
      "recursive deletion of workspace subtree",
      {
        riskCategory: "workspace_delete",
        severity: "medium"
      }
    );
  }

  return escalateLlm(
    "exec.delete.recursive_unknown_target",
    "recursive delete target is not covered by deterministic allow/block rules",
    {
      riskCategory: "destructive_delete",
      severity: "high"
    }
  );
}

function mutatingFindDecision(normalized) {
  if (hasAnyTarget(normalized, (target) => target.isFilesystemRoot || target.isRootGlob)) {
    return block("exec.find.root", "find mutation targets filesystem root", {
      riskCategory: "find_mutation",
      severity: "critical"
    });
  }

  if (hasAnyTarget(normalized, (target) => target.isWorkspaceRoot)) {
    return block("exec.find.workspace_root", "find mutation targets workspace root", {
      riskCategory: "find_mutation",
      severity: "critical"
    });
  }

  if (
    hasAnyTarget(
      normalized,
      (target) => target.isProtectedTarget || target.isInsideProtectedTarget
    )
  ) {
    return block("exec.find.protected_target", "find mutation targets protected path", {
      riskCategory: "protected_target_mutation",
      severity: "high"
    });
  }

  return escalateLlm(
    "exec.find.mutating_expression",
    "find mutating expression requires conservative escalation",
    {
      riskCategory: "find_mutation",
      severity: "medium"
    }
  );
}

function evaluateNormalized(normalized) {
  if (normalized.argv.length === 0) {
    return allow("exec.empty", "empty exec command", {
      riskCategory: "empty",
      severity: "none"
    });
  }

  if (normalized.operation === "recursive_delete") {
    return recursiveDeleteDecision(normalized);
  }

  if (normalized.operation === "find_delete" || normalized.operation === "find_exec") {
    return mutatingFindDecision(normalized);
  }

  if (CRITICAL_PROGRAMS.has(normalized.programBase)) {
    return block("exec.destructive.critical_program", "critical destructive program", {
      riskCategory: "critical_program",
      severity: "critical"
    });
  }

  if (normalized.operation === "disk_write") {
    return block("exec.dd.output_file", "dd with of= can overwrite data", {
      riskCategory: "disk_write",
      severity: "critical"
    });
  }

  if (normalized.operation === "chmod_recursive") {
    return block("exec.chmod.recursive", "recursive chmod is destructive", {
      riskCategory: "permission_change",
      severity: "high"
    });
  }

  if (normalized.operation === "chown_recursive") {
    return block("exec.chown.recursive", "recursive chown is destructive", {
      riskCategory: "permission_change",
      severity: "high"
    });
  }

  if (hasAmbiguousShellInput(normalized)) {
    return escalateLlm(
      "exec.shell.ambiguous",
      "shell syntax, expansion, or glob pattern requires conservative escalation",
      {
        riskCategory: "ambiguous_shell",
        severity: "medium"
      }
    );
  }

  if (
    normalized.operation === "interpreter_eval" ||
    INTERPRETERS.has(normalized.programBase)
  ) {
    return escalateLlm(
      "exec.interpreter.eval",
      "interpreter eval command requires conservative escalation",
      {
        riskCategory: "interpreter_eval",
        severity: "medium"
      }
    );
  }

  if (
    normalized.operation === "network_transfer" ||
    NETWORK_PROGRAMS.has(normalized.programBase)
  ) {
    return escalateLlm(
      "exec.network.transfer",
      "network transfer program requires conservative escalation",
      {
        riskCategory: "network_or_exfiltration",
        severity: "medium"
      }
    );
  }

  if (isAllowedReadonlyCommand(normalized)) {
    return allow("exec.safe.readonly", "known readonly command within workspace scope", {
      riskCategory: "readonly",
      severity: "low"
    });
  }

  return escalateLlm(
    "exec.unknown.escalate",
    "unknown command is not deterministically safe",
    {
      riskCategory: "unknown",
      severity: "medium"
    }
  );
}

export function evaluateExecPolicy({ command, workdir, workspaceRoot, config = {} }) {
  const startedAt = performance.now();
  const normalized = normalizeExecCommand({
    command,
    workdir,
    workspaceRoot,
    protectedTargets: config.protectedTargets,
    approvalTargets: config.approvalTargets
  });
  const verdict = evaluateNormalized(normalized);

  return withCommonFields(verdict, normalized, startedAt);
}
