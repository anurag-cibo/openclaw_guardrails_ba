import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DECISIONS = new Set(["allow", "block", "escalate_llm", "require_approval"]);
const APPROVAL_ARMS = new Set(["deny", "allow-once", "timeout"]);

function requiredString(row, field, context) {
  if (typeof row[field] !== "string" || row[field].trim() === "") {
    throw new Error(`${context}: ${field} muss eine nichtleere Zeichenkette sein`);
  }
}

function parseJsonl(text, source) {
  const rows = [];
  const ids = new Set();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${source}:${index + 1}: ungültiges JSON (${error.message})`);
    }
    const context = `${source}:${index + 1}`;
    requiredString(row, "id", context);
    if (ids.has(row.id)) throw new Error(`${context}: doppelte ID ${row.id}`);
    ids.add(row.id);
    rows.push(row);
  }
  if (!rows.length) throw new Error(`${source}: Korpus ist leer`);
  return rows;
}

function validateCommon(row, context) {
  for (const field of ["suite", "scenario", "risk_class", "prompt", "intended_command", "expected_decision", "effect"]) {
    requiredString(row, field, context);
  }
  if (!DECISIONS.has(row.expected_decision)) {
    throw new Error(`${context}: unbekannte expected_decision ${row.expected_decision}`);
  }
  if (![0, 1].includes(row.risk)) throw new Error(`${context}: risk muss 0 oder 1 sein`);
}

export function validateLiveCorpusRows(rows, source = "live corpus") {
  for (const [index, row] of rows.entries()) {
    const context = `${source}:${index + 1} (${row.id})`;
    validateCommon(row, context);
    if (row.suite !== "live") throw new Error(`${context}: suite muss live sein`);
    if (row.risk === 0 && row.success_check !== null && typeof row.success_check !== "object") {
      throw new Error(`${context}: success_check muss Objekt oder null sein`);
    }
  }
  return rows;
}

export function validateApprovalCorpusRows(rows, source = "approval corpus") {
  for (const [index, row] of rows.entries()) {
    const context = `${source}:${index + 1} (${row.id})`;
    validateCommon(row, context);
    if (row.suite !== "e6b") throw new Error(`${context}: suite muss e6b sein`);
    if (row.expected_decision !== "require_approval") {
      throw new Error(`${context}: E6b-Fälle müssen require_approval erwarten`);
    }
    requiredString(row, "fs_target", context);
    if (!Array.isArray(row.fixture_dirs) || !row.fixture_dirs.every((item) => typeof item === "string" && item)) {
      throw new Error(`${context}: fixture_dirs muss eine Liste nichtleerer Pfade sein`);
    }
    if (!Array.isArray(row.arms) || row.arms.length === 0 || !row.arms.every((arm) => APPROVAL_ARMS.has(arm))) {
      throw new Error(`${context}: ungültige Approval-Arme`);
    }
    if (typeof row.in_default_matrix !== "boolean") {
      throw new Error(`${context}: in_default_matrix muss boolesch sein`);
    }
    if (row.in_default_matrix && (!Number.isInteger(row.reps) || row.reps <= 0)) {
      throw new Error(`${context}: Default-Fälle benötigen positive ganzzahlige reps`);
    }
  }
  return rows;
}

export async function loadLiveCorpus(file, { expectedCases = null } = {}) {
  const text = await readFile(file, "utf8");
  const rows = validateLiveCorpusRows(parseJsonl(text, file), file);
  if (expectedCases !== null && rows.length !== expectedCases) {
    throw new Error(`${file}: ${rows.length} Fälle, erwartet ${expectedCases}`);
  }
  return { source: file, sha256: createHash("sha256").update(text, "utf8").digest("hex"), cases: rows };
}

export async function loadApprovalCorpus(file, { expectedCases = null } = {}) {
  const text = await readFile(file, "utf8");
  const rows = validateApprovalCorpusRows(parseJsonl(text, file), file);
  if (expectedCases !== null && rows.length !== expectedCases) {
    throw new Error(`${file}: ${rows.length} Fälle, erwartet ${expectedCases}`);
  }
  return { source: file, sha256: createHash("sha256").update(text, "utf8").digest("hex"), cases: rows };
}
