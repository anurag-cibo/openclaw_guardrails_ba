import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadPolicyCorpus, selectPilotCases } from "../lib/corpus.mjs";
import { atomicWriteJson, atomicWriteText } from "../lib/json.mjs";

export const DEFAULT_WORKSPACE_ROOT = "/home/node/.openclaw/workspace";

function countBy(rows, field) {
  return Object.fromEntries([...rows.reduce((counts, row) => {
    const key = row[field] ?? "null";
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right, "en")));
}

function rate(k, n) {
  return n ? k / n : null;
}

export function summarizePolicyResults(experimentId, corpus, selected, results, {
  corpusReference = corpus.source,
} = {}) {
  const matches = results.filter((row) => row.decision_match).length;
  const benign = results.filter((row) => row.risk === 0).length;
  const risky = results.filter((row) => row.risk === 1).length;
  const falsePositives = results.filter((row) => row.false_positive_c1).length;
  const falseNegatives = results.filter((row) => row.false_negative_c1).length;
  return {
    schemaVersion: 1,
    experimentId,
    adapter: "policy-offline",
    corpus: {
      source: corpusReference,
      sha256: corpus.sha256,
      totalCases: corpus.cases.length,
      selectedCases: selected.length,
      selectedCaseIds: selected.map((row) => row.id),
    },
    counts: {
      cases: results.length,
      decisionMatches: matches,
      benign,
      risky,
      falsePositiveC1: falsePositives,
      falseNegativeC1: falseNegatives,
      bypassC1: falseNegatives,
      errors: results.filter((row) => row.error !== null).length,
    },
    rates: {
      policyMatch: rate(matches, results.length),
      falsePositiveC1: rate(falsePositives, benign),
      falseNegativeC1: rate(falseNegatives, risky),
      bypassC1: rate(falseNegatives, risky),
    },
    distributions: {
      observedDecision: countBy(results, "observed_decision"),
      expectedDecision: countBy(results, "expected_decision"),
      riskClass: countBy(results, "risk_class"),
    },
  };
}

export async function runPolicyOffline({
  experimentId,
  corpusPath,
  policySource,
  rawOutput,
  summaryOutput,
  expectedCases = null,
  caseLimit = null,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
  config = {},
  corpusReference = null,
  rawReference = null,
}) {
  const corpus = await loadPolicyCorpus(corpusPath, { expectedCases });
  const selected = selectPilotCases(corpus.cases, caseLimit);
  const policyUrl = pathToFileURL(path.resolve(policySource)).href;
  const { evaluateExecPolicy } = await import(policyUrl);
  if (typeof evaluateExecPolicy !== "function") {
    throw new Error(`evaluateExecPolicy fehlt in ${policySource}`);
  }

  const results = [];
  for (const row of selected) {
    const workdir = row.workdir || workspaceRoot;
    let verdict;
    let error = null;
    try {
      verdict = evaluateExecPolicy({ command: row.command, workdir, workspaceRoot, config });
    } catch (caught) {
      error = String(caught?.message ?? caught);
      verdict = { decision: "block", ruleId: "internal_error", durationMs: null };
    }
    const observed = verdict.decision;
    const effectiveC1 = observed === "allow" ? "allow" : "block";
    const intervened = effectiveC1 === "block";
    const falsePositive = row.risk === 0 && intervened;
    const falseNegative = row.risk === 1 && effectiveC1 === "allow";
    results.push({
      id: row.id,
      suite: row.suite,
      risk_class: row.risk_class,
      bypass_class: row.bypass_class ?? null,
      command: row.command,
      workdir,
      expected_decision: row.expected_decision,
      observed_decision: observed,
      decision_match: observed === row.expected_decision,
      effective_c1: effectiveC1,
      risk: row.risk,
      false_positive_c1: falsePositive,
      false_negative_c1: falseNegative,
      bypass_c1: falseNegative,
      rule_id: verdict.ruleId ?? null,
      severity: verdict.severity ?? null,
      duration_ms: verdict.durationMs ?? null,
      target_canonicals: verdict.targetCanonicals ?? null,
      effect: row.effect ?? null,
      threat: row.threat ?? null,
      note: row.note ?? "",
      error,
    });
  }

  const rawText = `${results.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await atomicWriteText(rawOutput, rawText);
  const rawSha256 = createHash("sha256").update(rawText, "utf8").digest("hex");
  const summary = {
    ...summarizePolicyResults(experimentId, corpus, selected, results, {
      corpusReference: corpusReference ?? corpusPath,
    }),
    output: { raw: rawReference ?? rawOutput, sha256: rawSha256 },
  };
  await atomicWriteJson(summaryOutput, summary);
  return { corpus, selected, results, summary, rawSha256 };
}
