import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { appendJsonLine, atomicWriteJson, canonicalJson } from "./json.mjs";

export const RUN_STATES = Object.freeze([
  "created", "preflight", "ready", "running", "analyzing",
  "interrupted", "failed", "completed",
]);

const RUN_TRANSITIONS = Object.freeze({
  created: new Set(["preflight", "failed"]),
  preflight: new Set(["ready", "failed", "interrupted"]),
  ready: new Set(["running", "failed"]),
  running: new Set(["analyzing", "completed", "failed", "interrupted"]),
  analyzing: new Set(["completed", "failed", "interrupted"]),
  interrupted: new Set(["ready", "failed"]),
  failed: new Set(["ready"]),
  completed: new Set(),
});

const STAGE_TRANSITIONS = Object.freeze({
  pending: new Set(["running", "skipped"]),
  running: new Set(["succeeded", "failed"]),
  failed: new Set(["pending"]),
  succeeded: new Set(),
  skipped: new Set(),
});

export class RunStateError extends Error {}
export class RunLockedError extends RunStateError {}

export function generateRunId(kind, date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}_${kind}_${randomBytes(3).toString("hex")}`;
}

export function validateRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new RunStateError(`Ungültige Run-ID: ${runId}`);
  }
}

export function runPaths(root, runId) {
  validateRunId(runId);
  const directory = path.join(root, "artifacts", "runs", runId);
  return {
    directory,
    manifest: path.join(directory, "manifest.json"),
    status: path.join(directory, "status.json"),
    events: path.join(directory, "events.jsonl"),
    lock: path.join(directory, ".run.lock"),
    logs: path.join(directory, "logs"),
    raw: path.join(directory, "raw"),
    derived: path.join(directory, "derived"),
    inputs: path.join(directory, "inputs"),
  };
}

function iso(clock) {
  return clock().toISOString();
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function manifestDigest(manifest) {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

async function readAndVerifyRun(paths) {
  const [manifest, status] = await Promise.all([
    readJson(paths.manifest),
    readJson(paths.status),
  ]);
  if (manifest.runId !== status.runId || status.manifestSha256 !== manifestDigest(manifest)) {
    throw new RunStateError(`Manifest-Integritätsprüfung fehlgeschlagen: ${status.runId ?? path.basename(paths.directory)}`);
  }
  return { manifest, status };
}

async function acquireLock(paths, clock) {
  const token = randomUUID();
  let handle;
  try {
    handle = await open(paths.lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new RunLockedError(`Run ist gesperrt: ${path.basename(paths.directory)}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      token,
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: iso(clock),
    }, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return async () => {
    const current = await readJson(paths.lock).catch(() => null);
    if (current?.token === token) await rm(paths.lock, { force: true });
  };
}

async function withRunLock(paths, clock, operation) {
  const release = await acquireLock(paths, clock);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function writeStatus(paths, previous, next, event, clock) {
  const now = iso(clock);
  const status = {
    ...next,
    revision: previous.revision + 1,
    updatedAt: now,
  };
  await atomicWriteJson(paths.status, status);
  await appendJsonLine(paths.events, {
    schemaVersion: 1,
    sequence: status.revision,
    at: now,
    ...event,
  });
  return status;
}

export async function createRun(root, {
  kind,
  plan,
  fingerprints,
  runId = generateRunId(kind),
  metadata = {},
  clock = () => new Date(),
} = {}) {
  if (!new Set(["pilot", "main"]).has(kind)) throw new RunStateError(`Ungültige Run-Art: ${kind}`);
  if (!Array.isArray(plan) || plan.length === 0) throw new RunStateError("Run-Plan fehlt");
  const stageIds = plan.map((stage) => stage.id);
  if (new Set(stageIds).size !== stageIds.length) throw new RunStateError("Run-Plan enthält doppelte Stufen");
  validateRunId(runId);
  const paths = runPaths(root, runId);
  await mkdir(path.dirname(paths.directory), { recursive: true });
  try {
    await mkdir(paths.directory);
  } catch (error) {
    if (error.code === "EEXIST") throw new RunStateError(`Run existiert bereits: ${runId}`);
    throw error;
  }

  try {
    await Promise.all([paths.logs, paths.raw, paths.derived, paths.inputs]
      .map((directory) => mkdir(directory)));
    const createdAt = iso(clock);
    const manifest = {
      schemaVersion: 1,
      runId,
      kind,
      createdAt,
      plan,
      fingerprints,
      metadata,
      immutable: true,
    };
    const status = {
      schemaVersion: 1,
      runId,
      kind,
      state: "created",
      revision: 0,
      createdAt,
      updatedAt: createdAt,
      manifestSha256: manifestDigest(manifest),
      lastError: null,
      resumeCount: 0,
      artifacts: [],
      stages: plan.map((stage) => ({
        id: stage.id,
        status: "pending",
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        artifacts: null,
      })),
    };
    await atomicWriteJson(paths.manifest, manifest);
    await atomicWriteJson(paths.status, status);
    await appendJsonLine(paths.events, {
      schemaVersion: 1,
      sequence: 0,
      at: createdAt,
      type: "run.created",
      state: "created",
    });
    return { paths, manifest, status };
  } catch (error) {
    await rm(paths.directory, { recursive: true, force: true });
    throw error;
  }
}

export async function registerRunArtifacts(root, runId, artifacts, {
  note = "run-level artifacts registered",
  clock = () => new Date(),
} = {}) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new RunStateError("Run-Artefakte muessen als nichtleere Liste registriert werden");
  }
  const paths = runPaths(root, runId);
  return withRunLock(paths, clock, async () => {
    const { status: current } = await readAndVerifyRun(paths);
    if (!new Set(["created", "analyzing"]).has(current.state)) {
      throw new RunStateError(`Run-Artefakte koennen nur in created oder analyzing registriert werden, nicht in ${current.state}`);
    }
    const existing = current.artifacts ?? [];
    const duplicate = artifacts.find((candidate) => existing.some((item) =>
      item.role === candidate.role || item.path === candidate.path));
    if (duplicate) throw new RunStateError(`Run-Artefakt bereits registriert: ${duplicate.role ?? duplicate.path}`);
    const combined = [...existing, ...artifacts];
    return writeStatus(paths, current, { ...current, artifacts: combined }, {
      type: "run.artifacts",
      note,
      artifacts: artifacts.map((item) => ({ role: item.role, path: item.path, sha256: item.sha256 })),
    }, clock);
  });
}

export async function readRun(root, runId) {
  const paths = runPaths(root, runId);
  const { manifest, status } = await readAndVerifyRun(paths);
  return { paths, manifest, status };
}

export async function transitionRun(root, runId, nextState, {
  note = null,
  error = null,
  clock = () => new Date(),
} = {}) {
  if (!RUN_STATES.includes(nextState)) throw new RunStateError(`Unbekannter Run-Status: ${nextState}`);
  const paths = runPaths(root, runId);
  return withRunLock(paths, clock, async () => {
    const { status: current } = await readAndVerifyRun(paths);
    if (!RUN_TRANSITIONS[current.state]?.has(nextState)) {
      throw new RunStateError(`Ungültiger Run-Übergang: ${current.state} → ${nextState}`);
    }
    if (nextState === "completed") {
      const incomplete = current.stages.filter((stage) => !["succeeded", "skipped"].includes(stage.status));
      if (incomplete.length) throw new RunStateError(`Run nicht vollständig: ${incomplete.map((stage) => stage.id).join(", ")}`);
    }
    return writeStatus(paths, current, {
      ...current,
      state: nextState,
      lastError: error ?? (nextState === "failed" ? "unspecified failure" : current.lastError),
    }, {
      type: "run.transition",
      from: current.state,
      to: nextState,
      note,
      error,
    }, clock);
  });
}

export async function transitionStage(root, runId, stageId, nextStageStatus, {
  error = null,
  note = null,
  artifacts = null,
  clock = () => new Date(),
} = {}) {
  const paths = runPaths(root, runId);
  return withRunLock(paths, clock, async () => {
    const { status: current } = await readAndVerifyRun(paths);
    const index = current.stages.findIndex((stage) => stage.id === stageId);
    if (index < 0) throw new RunStateError(`Unbekannte Stufe: ${stageId}`);
    const stage = current.stages[index];
    if (!STAGE_TRANSITIONS[stage.status]?.has(nextStageStatus)) {
      throw new RunStateError(`Ungültiger Stufenübergang ${stageId}: ${stage.status} → ${nextStageStatus}`);
    }
    if (artifacts !== null && (nextStageStatus !== "succeeded" || !Array.isArray(artifacts))) {
      throw new RunStateError("Artefakte dürfen nur als Liste bei erfolgreichem Stufenabschluss gespeichert werden");
    }
    if (nextStageStatus === "running") {
      if (!["running", "analyzing"].includes(current.state)) {
        throw new RunStateError(`Stufe kann im Run-Status ${current.state} nicht starten`);
      }
      const blockers = current.stages.slice(0, index)
        .filter((item) => !["succeeded", "skipped"].includes(item.status));
      if (blockers.length) throw new RunStateError(`Vorherige Stufen nicht abgeschlossen: ${blockers.map((item) => item.id).join(", ")}`);
    }
    const now = iso(clock);
    const updatedStage = {
      ...stage,
      status: nextStageStatus,
      attempts: nextStageStatus === "running" ? stage.attempts + 1 : stage.attempts,
      startedAt: nextStageStatus === "running" ? now : stage.startedAt,
      finishedAt: ["succeeded", "failed", "skipped"].includes(nextStageStatus) ? now : null,
      lastError: nextStageStatus === "failed" ? (error ?? "unspecified failure") : null,
      artifacts: nextStageStatus === "succeeded" ? artifacts : null,
    };
    const stages = [...current.stages];
    stages[index] = updatedStage;
    const nextRunState = nextStageStatus === "failed" ? "failed" : current.state;
    return writeStatus(paths, current, {
      ...current,
      state: nextRunState,
      lastError: nextStageStatus === "failed" ? updatedStage.lastError : current.lastError,
      stages,
    }, {
      type: "stage.transition",
      stageId,
      from: stage.status,
      to: nextStageStatus,
      note,
      error,
    }, clock);
  });
}

export async function recoverRun(root, runId, {
  note = "manual recovery",
  clock = () => new Date(),
} = {}) {
  const paths = runPaths(root, runId);
  return withRunLock(paths, clock, async () => {
    const { status: current } = await readAndVerifyRun(paths);
    if (!["failed", "interrupted"].includes(current.state)) {
      throw new RunStateError(`Run kann aus ${current.state} nicht wiederaufgenommen werden`);
    }
    const stages = current.stages.map((stage) => ["failed", "running"].includes(stage.status)
      ? { ...stage, status: "pending", startedAt: null, finishedAt: null, lastError: null, artifacts: null }
      : stage);
    return writeStatus(paths, current, {
      ...current,
      state: "ready",
      stages,
      lastError: null,
      resumeCount: current.resumeCount + 1,
    }, {
      type: "run.recovered",
      from: current.state,
      to: "ready",
      note,
    }, clock);
  });
}

export async function listRuns(root) {
  const directory = path.join(root, "artifacts", "runs");
  try {
    const items = await readdir(directory, { withFileTypes: true });
    const runs = [];
    for (const item of items) {
      if (!item.isDirectory()) continue;
      try {
        const status = await readJson(path.join(directory, item.name, "status.json"));
        runs.push(status);
      } catch {
        runs.push({ runId: item.name, state: "corrupt", updatedAt: null });
      }
    }
    return runs.sort((left, right) => left.runId.localeCompare(right.runId));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function isRunLocked(root, runId) {
  try {
    await stat(runPaths(root, runId).lock);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function verifyRunArtifacts(root, runId) {
  const run = await readRun(root, runId);
  const errors = [];
  let checked = 0;
  const prefix = `${path.resolve(run.paths.directory)}${path.sep}`;
  const groups = [
    ...run.status.stages.map((stage) => ({ label: stage.id, artifacts: stage.artifacts ?? [] })),
    { label: "run", artifacts: run.status.artifacts ?? [] },
  ];
  for (const group of groups) {
    for (const artifact of group.artifacts) {
      checked += 1;
      if (!artifact || typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? "")) {
        errors.push(`${group.label}: ungültiger Artefakteintrag`);
        continue;
      }
      const absolute = path.resolve(run.paths.directory, artifact.path);
      if (!absolute.startsWith(prefix)) {
        errors.push(`${group.label}: Artefaktpfad verlässt Run-Verzeichnis: ${artifact.path}`);
        continue;
      }
      try {
        const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
        if (digest !== artifact.sha256) errors.push(`${group.label}: SHA-256 abweichend: ${artifact.path}`);
      } catch (error) {
        errors.push(`${group.label}: Artefakt nicht lesbar: ${artifact.path} (${error.code ?? error.message})`);
      }
    }
  }
  return { ok: errors.length === 0, checked, errors };
}
