import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const LIVE_EXPERIMENTS = new Set(["E5", "E6a", "E6b"]);
const PROFILE_KEYS = new Set(["$schema", "schemaVersion", "name", "kind", "experiments", "corpora", "models", "matrix", "retry"]);
const CORPUS_KEYS = new Set(["root", "path", "cases"]);
const CONFIGS = new Set(["C0", "C1", "C2", "C3"]);
const ARMS = new Set(["deny", "allow-once", "timeout"]);

function normalizedRelative(root, absolute, label, boundary = "Harness") {
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".") throw new Error(`${label}: Datei statt Harness-Wurzel erwartet`);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label}: Pfad muss innerhalb von ${boundary} liegen: ${absolute}`);
  }
  return relative.split(path.sep).join("/");
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} muss ein Objekt sein`);
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label}: unbekannte Felder: ${unknown.join(", ")}`);
}

function requiredString(value, key, label) {
  if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`${label}.${key} muss eine nichtleere Zeichenkette sein`);
  return value[key];
}

function boundedInteger(value, key, label, minimum, maximum) {
  const item = value[key];
  if (!Number.isInteger(item) || item < minimum || item > maximum) {
    throw new Error(`${label}.${key} muss eine Ganzzahl zwischen ${minimum} und ${maximum} sein`);
  }
  return item;
}

function boundedNumber(value, key, label, minimumExclusive, maximum) {
  const item = value[key];
  if (typeof item !== "number" || !Number.isFinite(item) || item <= minimumExclusive || item > maximum) {
    throw new Error(`${label}.${key} muss größer ${minimumExclusive} und höchstens ${maximum} sein`);
  }
  return item;
}

function uniqueList(value, key, label, allowed = null) {
  const items = value[key];
  if (!Array.isArray(items) || items.length === 0 || !items.every((item) => typeof item === "string" && item)) {
    throw new Error(`${label}.${key} muss eine nichtleere Liste von Zeichenketten sein`);
  }
  if (new Set(items).size !== items.length) throw new Error(`${label}.${key} enthält Duplikate`);
  const unknown = allowed ? items.filter((item) => !allowed.has(item)) : [];
  if (unknown.length) throw new Error(`${label}.${key} enthält unbekannte Werte: ${unknown.join(", ")}`);
  return [...items];
}

function validateModels(value) {
  assertObject(value, "Profil.models");
  rejectUnknownKeys(value, new Set(["agent", "judge", "judgeBaseUrl"]), "Profil.models");
  const models = {
    agent: requiredString(value, "agent", "Profil.models"),
    judge: requiredString(value, "judge", "Profil.models"),
    judgeBaseUrl: requiredString(value, "judgeBaseUrl", "Profil.models"),
  };
  for (const key of ["agent", "judge"]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(models[key])) throw new Error(`Profil.models.${key} enthält unzulässige Zeichen`);
  }
  let endpoint;
  try { endpoint = new URL(models.judgeBaseUrl); } catch { throw new Error("Profil.models.judgeBaseUrl ist keine gültige URL"); }
  if (!new Set(["http:", "https:"]).has(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("Profil.models.judgeBaseUrl braucht http(s) ohne Zugangsdaten");
  }
  return models;
}

function validateMatrix(value) {
  assertObject(value, "Profil.matrix");
  rejectUnknownKeys(value, new Set(["E5", "E6a", "E6b"]), "Profil.matrix");
  for (const id of ["E5", "E6a", "E6b"]) assertObject(value[id], `Profil.matrix.${id}`);
  rejectUnknownKeys(value.E5, new Set(["configs", "caseIds", "reps", "c3ApprovalPolicy"]), "Profil.matrix.E5");
  rejectUnknownKeys(value.E6a, new Set(["caseId", "arms", "reps", "c2Reps"]), "Profil.matrix.E6a");
  rejectUnknownKeys(value.E6b, new Set(["caseIds", "arms", "reps", "c2Reps", "c2CaseId"]), "Profil.matrix.E6b");
  const e5Policy = requiredString(value.E5, "c3ApprovalPolicy", "Profil.matrix.E5");
  if (!ARMS.has(e5Policy)) throw new Error(`Profil.matrix.E5.c3ApprovalPolicy ist ungültig: ${e5Policy}`);
  return {
    E5: {
      configs: uniqueList(value.E5, "configs", "Profil.matrix.E5", CONFIGS),
      caseIds: uniqueList(value.E5, "caseIds", "Profil.matrix.E5"),
      reps: boundedInteger(value.E5, "reps", "Profil.matrix.E5", 1, 1000),
      c3ApprovalPolicy: e5Policy,
    },
    E6a: {
      caseId: requiredString(value.E6a, "caseId", "Profil.matrix.E6a"),
      arms: uniqueList(value.E6a, "arms", "Profil.matrix.E6a", ARMS),
      reps: boundedInteger(value.E6a, "reps", "Profil.matrix.E6a", 1, 1000),
      c2Reps: boundedInteger(value.E6a, "c2Reps", "Profil.matrix.E6a", 0, 1000),
    },
    E6b: {
      caseIds: uniqueList(value.E6b, "caseIds", "Profil.matrix.E6b"),
      arms: uniqueList(value.E6b, "arms", "Profil.matrix.E6b", ARMS),
      reps: boundedInteger(value.E6b, "reps", "Profil.matrix.E6b", 1, 1000),
      c2Reps: boundedInteger(value.E6b, "c2Reps", "Profil.matrix.E6b", 0, 1000),
      c2CaseId: requiredString(value.E6b, "c2CaseId", "Profil.matrix.E6b"),
    },
  };
}

function validateRetry(value) {
  assertObject(value, "Profil.retry");
  rejectUnknownKeys(value, new Set(["phaseAttempts", "phaseDelayMs", "gatewayAttempts", "gatewayIntervalSeconds", "gatewayTimeoutSeconds", "toolPreflightAttempts"]), "Profil.retry");
  return {
    phaseAttempts: boundedInteger(value, "phaseAttempts", "Profil.retry", 1, 10),
    phaseDelayMs: boundedInteger(value, "phaseDelayMs", "Profil.retry", 0, 300_000),
    gatewayAttempts: boundedInteger(value, "gatewayAttempts", "Profil.retry", 1, 120),
    gatewayIntervalSeconds: boundedNumber(value, "gatewayIntervalSeconds", "Profil.retry", 0, 60),
    gatewayTimeoutSeconds: boundedNumber(value, "gatewayTimeoutSeconds", "Profil.retry", 0, 120),
    toolPreflightAttempts: boundedInteger(value, "toolPreflightAttempts", "Profil.retry", 1, 20),
  };
}

function normalizedDataPath(value, label) {
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) {
    throw new Error(`${label}: bei root=data muss path relativ sein`);
  }
  if (value.includes("\\")) throw new Error(`${label}: fÃ¼r portable Datenpfade nur '/' verwenden`);
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label}: Datenpfad verlÃ¤sst HARNESS_DATA_ROOT`);
  }
  return normalized;
}

async function resolveCorpus(root, profileDirectory, value, label, dataRoot) {
  assertObject(value, label);
  rejectUnknownKeys(value, CORPUS_KEYS, label);
  if (typeof value.path !== "string" || !value.path.trim()) throw new Error(`${label}.path muss eine nichtleere Zeichenkette sein`);
  if (!Number.isInteger(value.cases) || value.cases <= 0) throw new Error(`${label}.cases muss eine positive Ganzzahl sein`);
  const corpusRoot = value.root ?? "harness";
  if (!new Set(["harness", "data"]).has(corpusRoot)) throw new Error(`${label}.root muss 'harness' oder 'data' sein`);
  const dataRelative = corpusRoot === "data" ? normalizedDataPath(value.path, `${label}.path`) : null;
  const absolute = corpusRoot === "data"
    ? path.resolve(dataRoot, ...dataRelative.split("/"))
    : path.resolve(profileDirectory, value.path);
  const relative = corpusRoot === "data"
    ? normalizedRelative(dataRoot, absolute, `${label}.path`, "HARNESS_DATA_ROOT")
    : normalizedRelative(root, absolute, `${label}.path`);
  let info;
  try { info = await stat(absolute); } catch { throw new Error(`${label}.path fehlt: ${relative}`); }
  if (!info.isFile()) throw new Error(`${label}.path ist keine Datei: ${relative}`);
  const readPath = corpusRoot === "data" ? await realpath(absolute) : absolute;
  if (corpusRoot === "data") normalizedRelative(await realpath(dataRoot), readPath, `${label}.path`, "HARNESS_DATA_ROOT");
  return {
    root: corpusRoot,
    path: corpusRoot === "data" ? `/harness-data/${dataRelative}` : relative,
    readPath,
    cases: value.cases,
  };
}

export async function loadLiveProfile(root, profileFile, { dataRoot = process.env.HARNESS_DATA_ROOT ?? path.join(root, "corpora") } = {}) {
  if (typeof profileFile !== "string" || !profileFile.trim()) throw new Error("Profilpfad fehlt");
  const absolute = path.resolve(root, profileFile);
  let text;
  try { text = await readFile(absolute, "utf8"); } catch { throw new Error(`Profil nicht gefunden: ${absolute}`); }
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`Profil enthält ungültiges JSON: ${error.message}`); }
  assertObject(value, "Profil");
  rejectUnknownKeys(value, PROFILE_KEYS, "Profil");
  if (value.schemaVersion !== 1) throw new Error("Profil: schemaVersion muss 1 sein");
  if (typeof value.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value.name)) {
    throw new Error("Profil: name darf nur Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich enthalten");
  }
  if (!new Set(["pilot", "main"]).has(value.kind)) {
    throw new Error("Profil: kind muss 'pilot' oder 'main' sein");
  }
  if (!Array.isArray(value.experiments) || value.experiments.length === 0) throw new Error("Profil: experiments muss eine nichtleere Liste sein");
  if (new Set(value.experiments).size !== value.experiments.length) throw new Error("Profil: experiments enthält Duplikate");
  const unknown = value.experiments.filter((id) => !LIVE_EXPERIMENTS.has(id));
  if (unknown.length) throw new Error(`Profil: unbekannte Live-Experimente: ${unknown.join(", ")}`);
  assertObject(value.corpora, "Profil.corpora");
  rejectUnknownKeys(value.corpora, new Set(["live", "approval"]), "Profil.corpora");
  if (!value.corpora.live || !value.corpora.approval) throw new Error("Profil.corpora braucht live und approval");
  const directory = path.dirname(absolute);
  const absoluteDataRoot = path.resolve(dataRoot);
  const [live, approval] = await Promise.all([
    resolveCorpus(root, directory, value.corpora.live, "Profil.corpora.live", absoluteDataRoot),
    resolveCorpus(root, directory, value.corpora.approval, "Profil.corpora.approval", absoluteDataRoot),
  ]);
  const models = validateModels(value.models);
  const matrix = validateMatrix(value.matrix);
  const retry = validateRetry(value.retry);
  return {
    schemaVersion: 1,
    name: value.name,
    kind: value.kind,
    experiments: [...value.experiments],
    corpora: { live, approval },
    models,
    matrix,
    retry,
    source: absolute,
    sourceRelative: normalizedRelative(root, absolute, "Profil"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}
