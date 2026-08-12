import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const POLICY_DECISIONS = Object.freeze([
  "allow",
  "block",
  "require_approval",
  "escalate_llm",
]);

const DECISIONS = new Set(POLICY_DECISIONS);

export class CorpusValidationError extends Error {
  constructor(message, { source = null, line = null } = {}) {
    super(`${source ?? "Korpus"}${line ? `:${line}` : ""}: ${message}`);
    this.name = "CorpusValidationError";
    this.source = source;
    this.line = line;
  }
}

function fail(message, context) {
  throw new CorpusValidationError(message, context);
}

function requireString(row, field, context, { allowEmpty = false } = {}) {
  if (typeof row[field] !== "string" || (!allowEmpty && row[field].trim().length === 0)) {
    fail(`Feld '${field}' muss ein ${allowEmpty ? "String" : "nichtleerer String"} sein`, context);
  }
}

export function validatePolicyCase(row, context = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    fail("jede JSONL-Zeile muss ein JSON-Objekt sein", context);
  }
  for (const field of ["id", "suite", "risk_class", "command", "expected_decision"]) {
    requireString(row, field, context);
  }
  if (/[\r\n]/u.test(row.id) || row.id.length > 128) {
    fail("Feld 'id' darf keine Zeilenumbrüche enthalten und höchstens 128 Zeichen lang sein", context);
  }
  if (!DECISIONS.has(row.expected_decision)) {
    fail(`Feld 'expected_decision' muss einer der Werte ${POLICY_DECISIONS.join(" | ")} sein`, context);
  }
  if (row.risk !== 0 && row.risk !== 1) {
    fail("Feld 'risk' muss die Zahl 0 oder 1 sein", context);
  }
  if (row.workdir !== undefined && row.workdir !== null && typeof row.workdir !== "string") {
    fail("Feld 'workdir' muss null oder ein String sein", context);
  }
  for (const field of ["effect", "threat", "note", "source", "bypass_class", "evasion_class"]) {
    if (row[field] !== undefined && row[field] !== null && typeof row[field] !== "string") {
      fail(`optionales Feld '${field}' muss null oder ein String sein`, context);
    }
  }
  return row;
}

export async function loadPolicyCorpus(file, {
  expectedCases = null,
  expectedSuite = null,
} = {}) {
  const source = path.resolve(file);
  const buffer = await readFile(source);
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail("Datei ist nicht gültiges UTF-8", { source });
  }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const cases = [];
  const seen = new Map();
  for (const [index, rawLine] of content.split(/\r?\n/u).entries()) {
    if (!rawLine.trim()) continue;
    const context = { source, line: index + 1 };
    let row;
    try {
      row = JSON.parse(rawLine);
    } catch (error) {
      fail(`ungültiges JSON (${error.message})`, context);
    }
    validatePolicyCase(row, context);
    if (seen.has(row.id)) {
      fail(`doppelte Fall-ID '${row.id}' (zuerst in Zeile ${seen.get(row.id)})`, context);
    }
    seen.set(row.id, index + 1);
    if (expectedSuite && row.suite !== expectedSuite) {
      fail(`Suite '${row.suite}' stimmt nicht mit erwarteter Suite '${expectedSuite}' überein`, context);
    }
    cases.push(row);
  }
  if (!cases.length) fail("Korpus enthält keine Fälle", { source });
  if (expectedCases !== null && cases.length !== expectedCases) {
    fail(`erwartet ${expectedCases} Fälle, gefunden ${cases.length}`, { source });
  }
  return {
    source,
    format: "jsonl",
    sha256: createHash("sha256").update(buffer).digest("hex"),
    cases,
  };
}

export async function loadPolicyCorpusSet(files, { expectedCases = null } = {}) {
  if (!Array.isArray(files) || !files.length) throw new CorpusValidationError("Korpusdateiliste ist leer");
  const components = [];
  const cases = [];
  const seen = new Map();
  for (const file of files) {
    const component = await loadPolicyCorpus(file);
    components.push({ source: component.source, sha256: component.sha256, cases: component.cases.length });
    for (const row of component.cases) {
      if (seen.has(row.id)) {
        throw new CorpusValidationError(
          `doppelte Fall-ID '${row.id}' in zusammengesetztem Korpus (${seen.get(row.id)} und ${component.source})`,
        );
      }
      seen.set(row.id, component.source);
      cases.push(row);
    }
  }
  if (expectedCases !== null && cases.length !== expectedCases) {
    throw new CorpusValidationError(`erwartet ${expectedCases} Fälle, gefunden ${cases.length}`);
  }
  const signature = components.map((item) => `${item.sha256}  ${path.basename(item.source)}`).join("\n");
  return {
    source: components.map((item) => item.source),
    format: "jsonl-composite",
    sha256: createHash("sha256").update(`${signature}\n`, "utf8").digest("hex"),
    components,
    cases,
  };
}

export function selectPilotCases(cases, limit) {
  if (limit === null || limit === undefined || limit >= cases.length) return [...cases];
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Pilotumfang muss eine positive Ganzzahl sein");
  const groups = new Map();
  for (const row of cases) {
    const key = `${row.risk}|${row.expected_decision}|${row.risk_class}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const queues = [...groups.values()];
  const selected = [];
  for (let round = 0; selected.length < limit; round += 1) {
    let added = false;
    for (const queue of queues) {
      if (queue[round] && selected.length < limit) {
        selected.push(queue[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return selected;
}
