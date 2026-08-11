#!/usr/bin/env node
import { measurePolicyLatency } from "./latency-core.mjs";

const [
  corpusPath,
  policySource,
  outputPath,
  iterationsValue,
  warmupValue,
  expectedCasesValue,
  roundValue,
] = process.argv.slice(2);

try {
  await measurePolicyLatency({
    corpusPath,
    policySource,
    outputPath,
    iterations: Number(iterationsValue),
    warmupCalls: Number(warmupValue),
    expectedCases: expectedCasesValue === "null" ? null : Number(expectedCasesValue),
    round: Number(roundValue),
  });
} catch (error) {
  console.error(`[E3-WORKER] ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
