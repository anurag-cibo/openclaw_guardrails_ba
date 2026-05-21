import path from "node:path";

const posix = path.posix;
const DEFAULT_WORKSPACE_ROOT = "/home/node/.openclaw/workspace";
const DEFAULT_PROTECTED_TARGETS = ["guardrail-lab"];
const DEFAULT_APPROVAL_TARGETS = ["guardrail-lab/tmp"];
const OPTION_END = "--";

const INTERPRETER_EVAL_FLAGS = new Map([
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["node", new Set(["-e", "--eval"])],
  ["bash", new Set(["-c"])],
  ["sh", new Set(["-c"])]
]);

const NETWORK_PROGRAMS = new Set(["curl", "wget", "scp", "rsync", "nc"]);
const GREP_OPTIONS_WITH_ARGUMENT = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
  "--exclude",
  "--include",
  "--exclude-dir",
  "--include-dir"
]);

export function tokenizeShellLike(command) {
  return tokenizeShellLikeDetailed(command).argv;
}

function tokenizeShellLikeDetailed(command) {
  const input = String(command ?? "");
  const argv = [];
  const parseWarnings = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let complexShell = false;
  let hasVariableExpansion = false;
  let hasTildeExpansion = false;
  let hasGlobPattern = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      argv.push(current);
      current = "";
    }
  };

  const markComplex = (operator) => {
    complexShell = true;
    parseWarnings.push(`complex shell operator detected: ${operator}`);
  };

  const markVariableExpansion = () => {
    hasVariableExpansion = true;
    complexShell = true;
    parseWarnings.push("shell variable expansion detected");
  };

  const markTildeExpansion = () => {
    hasTildeExpansion = true;
    complexShell = true;
    parseWarnings.push("shell tilde expansion detected");
  };

  const markGlobPattern = () => {
    hasGlobPattern = true;
    complexShell = true;
    parseWarnings.push("shell glob pattern detected");
  };

  const shouldMarkVariableExpansion = (next) =>
    next === "{" || /[A-Za-z_]/u.test(next ?? "");

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }

      if (quote !== "'" && char === "`") {
        markComplex("`...`");
      }

      if (quote !== "'" && char === "$" && next === "(") {
        markComplex("$(...)");
      } else if (quote !== "'" && char === "$" && shouldMarkVariableExpansion(next)) {
        markVariableExpansion();
      }

      current += char;
      continue;
    }

    if (char === "\r" || char === "\n") {
      pushCurrent();
      markComplex("newline");
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === "~" && current.length === 0) {
      markTildeExpansion();
      current += char;
      continue;
    }

    if (char === "*" || char === "?" || char === "[") {
      markGlobPattern();
      current += char;
      continue;
    }

    if (char === "&" && next === "&") {
      pushCurrent();
      markComplex("&&");
      index += 1;
      continue;
    }

    if (char === "|" && next === "|") {
      pushCurrent();
      markComplex("||");
      index += 1;
      continue;
    }

    if (char === ">" && next === ">") {
      pushCurrent();
      markComplex(">>");
      index += 1;
      continue;
    }

    if (char === ";" || char === "|" || char === ">" || char === "<") {
      pushCurrent();
      markComplex(char);
      continue;
    }

    if (char === "`") {
      markComplex("`...`");
      current += char;
      continue;
    }

    if (char === "$" && next === "(") {
      markComplex("$(...)");
      current += char;
      continue;
    }

    if (char === "$" && shouldMarkVariableExpansion(next)) {
      markVariableExpansion();
      current += char;
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += "\\";
    parseWarnings.push("trailing backslash escape");
  }

  if (quote) {
    parseWarnings.push(`unterminated ${quote === "'" ? "single" : "double"} quote`);
  }

  pushCurrent();

  return {
    argv,
    complexShell,
    parseWarnings,
    hasVariableExpansion,
    hasTildeExpansion,
    hasGlobPattern
  };
}

function stripTrailingSlash(canonicalPath) {
  if (canonicalPath === "/") {
    return canonicalPath;
  }

  return canonicalPath.replace(/\/+$/u, "");
}

function normalizeAbsolutePath(rawPath, baseDir) {
  const value = String(rawPath ?? "");
  const normalized = value.startsWith("/")
    ? posix.normalize(value)
    : posix.resolve(baseDir, value);

  return stripTrailingSlash(normalized);
}

function isPathInside(candidate, root) {
  if (root === "/") {
    return candidate.startsWith("/");
  }

  return candidate === root || candidate.startsWith(`${root}/`);
}

function isPathDescendant(candidate, root) {
  return root !== "/" && candidate.startsWith(`${root}/`);
}

function normalizePolicyTargets(targets, workspaceRootCanonical, defaults) {
  const selectedTargets = Array.isArray(targets) && targets.length > 0
    ? targets
    : defaults;

  return selectedTargets
    .filter((target) => typeof target === "string" && target.trim().length > 0)
    .map((target) => normalizeAbsolutePath(target.trim(), workspaceRootCanonical));
}

function makeTargetInfo(
  rawTarget,
  workdirCanonical,
  workspaceRootCanonical,
  protectedTargetCanonicals,
  approvalTargetCanonicals
) {
  const raw = String(rawTarget ?? "");
  const canonical = normalizeAbsolutePath(raw, workdirCanonical);
  const isWorkspaceRoot = canonical === workspaceRootCanonical;
  const isInsideWorkspace = isPathInside(canonical, workspaceRootCanonical);
  const isOutsideWorkspace = !isInsideWorkspace;
  const matchingProtectedTarget =
    protectedTargetCanonicals.find((target) => target === canonical) ?? null;
  const matchingApprovalTarget =
    approvalTargetCanonicals.find((target) => target === canonical) ?? null;
  const containingProtectedTarget =
    protectedTargetCanonicals.find((target) => isPathDescendant(canonical, target)) ??
    null;
  const containingApprovalTarget =
    approvalTargetCanonicals.find((target) => isPathDescendant(canonical, target)) ??
    null;

  let scope = "outside_workspace";
  if (isWorkspaceRoot) {
    scope = "workspace_root";
  } else if (isInsideWorkspace) {
    scope = "inside_workspace";
  }

  return {
    raw,
    canonical,
    scope,
    isAbsolute: raw.startsWith("/"),
    isWorkspaceRoot,
    isInsideWorkspace,
    isWithinWorkspace: isInsideWorkspace,
    isOutsideWorkspace,
    isProtectedTarget: Boolean(matchingProtectedTarget),
    isInsideProtectedTarget: Boolean(containingProtectedTarget),
    isApprovalTarget: Boolean(matchingApprovalTarget),
    isInsideApprovalTarget: Boolean(containingApprovalTarget),
    matchingProtectedTarget,
    containingProtectedTarget,
    matchingApprovalTarget,
    containingApprovalTarget,
    isFilesystemRoot: canonical === "/",
    isRootGlob: raw === "/*" || raw === "/**"
  };
}

function programBaseName(program) {
  if (!program) {
    return null;
  }

  return posix.basename(program);
}

function parseRmArguments(argv) {
  const flags = {
    raw: [],
    recursive: false,
    force: false
  };
  const operands = [];
  let optionsEnded = false;

  for (const token of argv.slice(1)) {
    if (!optionsEnded && token === OPTION_END) {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && token.startsWith("-") && token !== "-") {
      flags.raw.push(token);

      if (token === "--recursive") {
        flags.recursive = true;
      } else if (token === "--force") {
        flags.force = true;
      } else if (token.startsWith("--")) {
        continue;
      } else {
        for (const flag of token.slice(1)) {
          if (flag === "r" || flag === "R") {
            flags.recursive = true;
          }
          if (flag === "f") {
            flags.force = true;
          }
        }
      }

      continue;
    }

    operands.push(token);
  }

  return {
    flags,
    operands,
    operation: flags.recursive ? "recursive_delete" : "delete"
  };
}

function parseRecursiveCommand(argv) {
  const flags = {
    raw: [],
    recursive: false
  };
  const operands = [];
  let optionsEnded = false;

  for (const token of argv.slice(1)) {
    if (!optionsEnded && token === OPTION_END) {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && token.startsWith("-") && token !== "-") {
      flags.raw.push(token);
      if (token === "--recursive" || token.includes("R")) {
        flags.recursive = true;
      }
      continue;
    }

    operands.push(token);
  }

  return { flags, operands };
}

function parseReadFileArguments(argv, programBase) {
  const flags = { raw: [] };
  const operands = [];
  let optionsEnded = false;
  let skipNext = false;

  for (const token of argv.slice(1)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (!optionsEnded && token === OPTION_END) {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && token.startsWith("-") && token !== "-") {
      flags.raw.push(token);

      if (
        (programBase === "head" || programBase === "tail") &&
        ["-n", "-c", "--lines", "--bytes"].includes(token)
      ) {
        skipNext = true;
      }

      continue;
    }

    operands.push(token);
  }

  return { flags, operands };
}

function isGrepOptionWithInlineArgument(token) {
  return (
    token.startsWith("--regexp=") ||
    token.startsWith("--file=") ||
    token.startsWith("--exclude=") ||
    token.startsWith("--include=") ||
    token.startsWith("--exclude-dir=") ||
    token.startsWith("--include-dir=") ||
    token.startsWith("-e") && token.length > 2 ||
    token.startsWith("-f") && token.length > 2
  );
}

function parseGrepArguments(argv) {
  const flags = { raw: [], pattern: null };
  const operands = [];
  let optionsEnded = false;
  let skipNextAsOptionArgument = false;
  let patternSeen = false;

  for (const token of argv.slice(1)) {
    if (skipNextAsOptionArgument) {
      if (!patternSeen) {
        flags.pattern = token;
        patternSeen = true;
      }
      skipNextAsOptionArgument = false;
      continue;
    }

    if (!optionsEnded && token === OPTION_END) {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && token.startsWith("-") && token !== "-") {
      flags.raw.push(token);

      if (GREP_OPTIONS_WITH_ARGUMENT.has(token)) {
        skipNextAsOptionArgument = true;
      } else if (isGrepOptionWithInlineArgument(token)) {
        patternSeen = true;
      }

      continue;
    }

    if (!patternSeen) {
      flags.pattern = token;
      patternSeen = true;
      continue;
    }

    operands.push(token);
  }

  return { flags, operands };
}

function parseFindArguments(argv) {
  const flags = {
    raw: [],
    hasDelete: false,
    hasExec: false
  };
  const operands = [];
  let beforeExpression = true;

  for (const token of argv.slice(1)) {
    if (token === "-delete") {
      flags.raw.push(token);
      flags.hasDelete = true;
      beforeExpression = false;
      continue;
    }

    if (token === "-exec" || token === "-execdir") {
      flags.raw.push(token);
      flags.hasExec = true;
      beforeExpression = false;
      continue;
    }

    if (token.startsWith("-") || token === "(" || token === "!" || token === ")") {
      flags.raw.push(token);
      beforeExpression = false;
      continue;
    }

    if (beforeExpression) {
      operands.push(token);
    }
  }

  if (operands.length === 0) {
    operands.push(".");
  }

  let operation = "find";
  if (flags.hasDelete) {
    operation = "find_delete";
  } else if (flags.hasExec) {
    operation = "find_exec";
  }

  return { flags, operands, operation };
}

function parseGenericArguments(argv) {
  const flags = { raw: [] };
  const operands = [];
  let optionsEnded = false;

  for (const token of argv.slice(1)) {
    if (!optionsEnded && token === OPTION_END) {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && token.startsWith("-") && token !== "-") {
      flags.raw.push(token);
      continue;
    }

    operands.push(token);
  }

  return { flags, operands };
}

function hasInterpreterEval(programBase, argv) {
  const evalFlags = INTERPRETER_EVAL_FLAGS.get(programBase);
  if (!evalFlags) {
    return false;
  }

  return argv.slice(1).some((token) => evalFlags.has(token));
}

function classifyOperation(programBase, argv, currentOperation) {
  if (!programBase) {
    return "empty";
  }

  if (currentOperation) {
    return currentOperation;
  }

  if (NETWORK_PROGRAMS.has(programBase)) {
    return "network_transfer";
  }

  if (hasInterpreterEval(programBase, argv)) {
    return "interpreter_eval";
  }

  if (programBase === "dd" && argv.slice(1).some((token) => token.startsWith("of="))) {
    return "disk_write";
  }

  if (programBase === "git") {
    return "git_command";
  }

  return "command";
}

export function normalizeExecCommand({
  command,
  workdir,
  workspaceRoot,
  protectedTargets,
  approvalTargets
}) {
  const rawCommand = String(command ?? "");
  const workspaceRootCanonical = normalizeAbsolutePath(
    workspaceRoot || DEFAULT_WORKSPACE_ROOT,
    "/"
  );
  const workdirCanonical = normalizeAbsolutePath(
    workdir || workspaceRootCanonical,
    workspaceRootCanonical
  );
  const protectedTargetCanonicals = normalizePolicyTargets(
    protectedTargets,
    workspaceRootCanonical,
    DEFAULT_PROTECTED_TARGETS
  );
  const approvalTargetCanonicals = normalizePolicyTargets(
    approvalTargets,
    workspaceRootCanonical,
    DEFAULT_APPROVAL_TARGETS
  );
  const tokenized = tokenizeShellLikeDetailed(rawCommand);
  const argv = tokenized.argv;
  const program = argv[0] ?? null;
  const programBase = programBaseName(program);
  let flags = { raw: [] };
  let operands = [];
  let operation = null;

  if (programBase === "rm") {
    ({ flags, operands, operation } = parseRmArguments(argv));
  } else if (programBase === "find") {
    ({ flags, operands, operation } = parseFindArguments(argv));
  } else if (programBase === "chmod" || programBase === "chown") {
    ({ flags, operands } = parseRecursiveCommand(argv));
    operation = flags.recursive
      ? `${programBase}_recursive`
      : `${programBase}_change`;
  } else if (programBase === "cat" || programBase === "head" || programBase === "tail") {
    ({ flags, operands } = parseReadFileArguments(argv, programBase));
  } else if (programBase === "grep") {
    ({ flags, operands } = parseGrepArguments(argv));
  } else {
    ({ flags, operands } = parseGenericArguments(argv));
  }

  operation = classifyOperation(programBase, argv, operation);

  const targets = operands;
  const targetInfos = targets.map((target) =>
    makeTargetInfo(
      target,
      workdirCanonical,
      workspaceRootCanonical,
      protectedTargetCanonicals,
      approvalTargetCanonicals
    )
  );
  const targetCanonicals = targetInfos.map((target) => target.canonical);

  return {
    rawCommand,
    argv,
    program,
    programBase,
    flags,
    operands,
    operation,
    targets,
    targetCanonicals,
    targetInfos,
    protectedTargets: protectedTargetCanonicals,
    approvalTargets: approvalTargetCanonicals,
    workspaceRoot: workspaceRootCanonical,
    workdir: workdirCanonical,
    complexShell: tokenized.complexShell,
    hasVariableExpansion: tokenized.hasVariableExpansion,
    hasTildeExpansion: tokenized.hasTildeExpansion,
    hasGlobPattern: tokenized.hasGlobPattern,
    hasUnsafeExpansion:
      tokenized.hasVariableExpansion ||
      tokenized.hasTildeExpansion ||
      tokenized.hasGlobPattern,
    parseWarnings: tokenized.parseWarnings
  };
}
