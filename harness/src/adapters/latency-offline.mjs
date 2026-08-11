import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "../lib/json.mjs";
import { sha256File } from "../lib/registry.mjs";

const DEFAULT_WORKER = fileURLToPath(new URL("./latency-worker.mjs", import.meta.url));

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} muss eine positive Ganzzahl sein`);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeRounds(rounds, key) {
  const names = ["mean_ms", "p50_ms", "p95_ms", "p99_ms", "min_ms", "max_ms"];
  return Object.fromEntries(names.map((name) => {
    const values = rounds.map((round) => round[key][name]);
    return [name, { roundValues: values, meanAcrossRounds: mean(values) }];
  }));
}

export async function runLatencyOffline({
  experimentId = "E3",
  corpusPath,
  policySource,
  rawOutputDirectory,
  summaryOutput,
  iterations,
  rounds,
  warmupCalls = 5000,
  expectedCases = null,
  workerPath = DEFAULT_WORKER,
}) {
  positiveInteger(iterations, "iterations");
  positiveInteger(rounds, "rounds");
  const outputs = [];
  const logs = [];
  for (let round = 1; round <= rounds; round += 1) {
    const outputPath = path.join(rawOutputDirectory, `round-${String(round).padStart(2, "0")}.json`);
    const child = spawnSync(process.execPath, [
      workerPath,
      corpusPath,
      policySource,
      outputPath,
      String(iterations),
      String(warmupCalls),
      expectedCases === null ? "null" : String(expectedCases),
      String(round),
    ], { encoding: "utf8", windowsHide: true });
    logs.push(`round ${round}: exit=${child.status}\n${child.stdout ?? ""}${child.stderr ?? ""}`.trim());
    if (child.error || child.status !== 0) {
      throw new Error(`E3-Runde ${round} fehlgeschlagen: ${child.error?.message ?? child.stderr ?? `exit ${child.status}`}`);
    }
    const data = JSON.parse(await readFile(outputPath, "utf8"));
    const expectedEvaluations = expectedCases * iterations;
    if (
      data.meta.round !== round ||
      data.meta.iterations_per_command !== iterations ||
      (expectedCases !== null && data.meta.commands !== expectedCases) ||
      (expectedCases !== null && data.meta.total_evaluations !== expectedEvaluations) ||
      data.overall_self.n !== data.meta.total_evaluations ||
      data.overall_wall.n !== data.meta.total_evaluations
    ) {
      throw new Error(`E3-Runde ${round} ist unvollständig oder gehört zu einer anderen Konfiguration`);
    }
    outputs.push({ outputPath, sha256: await sha256File(outputPath), data });
  }

  const commands = outputs[0].data.meta.commands;
  const evaluationsPerRound = commands * iterations;
  const summary = {
    schemaVersion: 1,
    experimentId,
    adapter: "latency-offline",
    configuration: {
      rounds,
      iterationsPerCommand: iterations,
      commands,
      evaluationsPerRound,
      totalEvaluations: evaluationsPerRound * rounds,
      warmupCallsPerRound: warmupCalls,
      freshNodeProcessPerRound: true,
    },
    corpus: { sha256: outputs[0].data.corpus.sha256 },
    runtime: {
      node: outputs[0].data.meta.node,
      platform: outputs[0].data.meta.platform,
      arch: outputs[0].data.meta.arch,
    },
    rounds: outputs.map(({ outputPath, sha256, data }) => ({
      round: data.meta.round,
      file: path.basename(outputPath),
      sha256,
      overallSelf: data.overall_self,
      overallWall: data.overall_wall,
    })),
    overallSelfAcrossRounds: summarizeRounds(outputs.map((item) => item.data), "overall_self"),
    overallWallAcrossRounds: summarizeRounds(outputs.map((item) => item.data), "overall_wall"),
  };
  await atomicWriteJson(summaryOutput, summary);
  return { summary, outputs, logs };
}
