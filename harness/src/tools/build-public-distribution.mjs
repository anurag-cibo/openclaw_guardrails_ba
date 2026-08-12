#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { treeInventory } from "../lib/registry.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC_ROOT = path.join(SOURCE_ROOT, "runtime/public");

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function copyFile(relative, outputRoot, target = relative) {
  const destination = path.join(outputRoot, target);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(SOURCE_ROOT, relative), destination);
}

async function copyTree(relative, outputRoot, target = relative) {
  const destination = path.join(outputRoot, target);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(SOURCE_ROOT, relative), destination, { recursive: true });
}

async function sha256(relative, outputRoot) {
  return createHash("sha256").update(await readFile(path.join(outputRoot, relative))).digest("hex");
}

async function filesBelow(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(root, absolute));
    else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return output.sort((left, right) => left.localeCompare(right, "en"));
}

async function writeJson(outputRoot, relative, value) {
  const destination = path.join(outputRoot, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function requireExplicitOpenClawRepo(outputRoot, relative) {
  const file = path.join(outputRoot, relative);
  const source = await readFile(file, "utf8");
  const replaced = source.replace(
    /OPENCLAW_REPO="\$\{OPENCLAW_REPO:-[^}]+\}"/u,
    'OPENCLAW_REPO="${OPENCLAW_REPO:?OPENCLAW_REPO muss als absoluter Pfad gesetzt sein}"',
  );
  if (replaced === source && !source.includes("OPENCLAW_REPO:?")) {
    throw new Error(`OPENCLAW_REPO weder als Default noch als Pflichtvariable gefunden: ${relative}`);
  }
  await writeFile(file, replaced, "utf8");
}

function publicExperiments() {
  return {
    schemaVersion: 1,
    canonicalOrder: ["E1", "E2", "E3", "E4", "E5", "E6a", "E6b"],
    experiments: {
      E1: {
        title: "Policy-Beispielcharakterisierung", level: "lab", runner: "policy",
        adapter: "src/adapters/policy-offline.mjs", corpus: "policy",
        expected: { unit: "cases", count: 8 }, run: { cases: 8 }, pilot: { cases: 4 },
      },
      E2: {
        title: "Evasion-Beispielcharakterisierung", level: "lab", runner: "policy",
        adapter: "src/adapters/policy-offline.mjs", corpus: "evasion",
        expected: { unit: "cases", count: 4 }, run: { cases: 4 }, pilot: { cases: 4 },
      },
      E3: {
        title: "Kurzer deterministischer Overhead-Test", level: "lab", runner: "latency",
        adapter: "src/adapters/latency-offline.mjs", corpus: "policy",
        expected: { unit: "evaluations", count: 800 },
        run: { iterations: 100, rounds: 1, warmupCalls: 100 },
        pilot: { iterations: 20, rounds: 1, warmupCalls: 50 },
      },
      E4: {
        title: "Judge-Beispielcharakterisierung", level: "lab", runner: "judge",
        adapter: "src/adapters/judge-offline.mjs", corpus: "judge-core",
        expected: { unit: "calls", count: 4, cases: 4 },
        run: { cases: 4, repetitions: 1 }, pilot: { cases: 2, repetitions: 1 },
      },
      E5: {
        title: "Live End-to-End", level: "live", runner: "live",
        adapter: "adapters/live/run_e5.sh", corpus: "live",
        configs: ["C0", "C1", "C2", "C3"], expected: { unit: "runs", count: 16 },
        pilot: { cases: 4, repetitions: 1 },
      },
      E6a: {
        title: "Approval-Lifecycle", level: "live", runner: "approval",
        adapter: "adapters/live/run_e6.sh", corpus: "live",
        expected: { unit: "runs", count: 4 }, pilot: { repetitions: 1 },
      },
      E6b: {
        title: "Approval ueber Core-exec", level: "live", runner: "approval",
        adapter: "adapters/live/run_e6b.sh", corpus: "approval",
        expected: { unit: "runs", count: 12 }, pilot: { cases: 5, repetitions: 1 },
      },
    },
  };
}

export async function buildPublicDistribution(outputDirectory) {
  const outputRoot = path.resolve(outputDirectory);
  if (!inside(PUBLIC_ROOT, outputRoot)) {
    throw new Error(`Ausgabe muss ein Unterverzeichnis von ${PUBLIC_ROOT} sein`);
  }
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  for (const directory of ["src/adapters", "src/lib", "adapters/live", "vendor/plugin-baseline"]) await copyTree(directory, outputRoot);
  await copyFile("src/cli.mjs", outputRoot);
  for (const relative of [
    "bin/harness", "bin/host-info.sh", "bin/job-control.sh", "bin/live-lock.sh",
    "bin/live-pilot.sh", "bin/target-preflight.sh",
    "runtime/compose.yaml", "runtime/judge.compose.yaml", "runtime/live.compose.yaml",
    "runtime/Dockerfile", "runtime/HostRunner.Dockerfile", "runtime/image-lock.json",
    "runtime/host-runner-lock.json",
    "profiles/live-profile.schema.json", "profiles/live-smoke.example.json",
    "profiles/live-pilot.example.json", "profiles/live-pilot.data-root.example.json",
    "profiles/live-main-pilot.example.json", "profiles/live-main.example.json",
    "profiles/README.md",
    "corpora/pilot/policy.jsonl", "corpora/pilot/evasion.jsonl",
    "corpora/pilot/live.jsonl", "corpora/pilot/approval.jsonl",
    "corpora/examples/minimal_policy.jsonl", "corpora/schemas/live-case.schema.json",
    "corpora/schemas/approval-case.schema.json", "registry/corpus-case.schema.json",
  ]) await copyFile(relative, outputRoot);

  for (const relative of [
    "runners/approval_responder.py", "runners/evaluate_live_run.py",
    "runners/gateway_admin_call.py", "runners/run_live.sh",
    "runners/run_e6b.sh", "runners/setup_lab.sh",
  ]) await copyFile(relative, outputRoot);
  await copyTree("corpora/fixtures/injection", outputRoot);
  for (const relative of [
    "runners/run_live.sh", "runners/run_e6b.sh", "runners/setup_lab.sh",
  ]) await requireExplicitOpenClawRepo(outputRoot, relative);

  await copyFile("README.md", outputRoot, "README.md");
  await copyTree("docs", outputRoot, "docs");
  await copyFile("distribution/public/tests/public-smoke.test.mjs", outputRoot, "tests/public-smoke.test.mjs");

  const corpora = {
    schemaVersion: 1,
    corpora: {
      policy: {
        path: "corpora/pilot/policy.jsonl", format: "jsonl", cases: 8,
        origin: "public-sanitized-example", sha256: await sha256("corpora/pilot/policy.jsonl", outputRoot),
      },
      evasion: {
        path: "corpora/pilot/evasion.jsonl", format: "jsonl", cases: 4,
        origin: "public-sanitized-example", sha256: await sha256("corpora/pilot/evasion.jsonl", outputRoot),
      },
      "judge-core": {
        paths: ["corpora/pilot/policy.jsonl", "corpora/pilot/evasion.jsonl"],
        format: "jsonl-composite", cases: 12, origin: "public-example-composite",
        sha256: {
          policy: await sha256("corpora/pilot/policy.jsonl", outputRoot),
          evasion: await sha256("corpora/pilot/evasion.jsonl", outputRoot),
        },
      },
      live: {
        path: "corpora/pilot/live.jsonl", format: "jsonl", cases: 4,
        origin: "public-sanitized-example", sha256: await sha256("corpora/pilot/live.jsonl", outputRoot),
      },
      approval: {
        path: "corpora/pilot/approval.jsonl", format: "jsonl", cases: 5,
        origin: "public-sanitized-example", sha256: await sha256("corpora/pilot/approval.jsonl", outputRoot),
      },
    },
  };
  await writeJson(outputRoot, "registry/experiments.json", publicExperiments());
  await writeJson(outputRoot, "registry/corpora.json", corpora);
  await writeJson(outputRoot, "registry/analysis.json", {
    schemaVersion: 1,
    components: [],
    currentSynthesis: { status: "generated-per-main-run", reason: "Profilgebundene Hauptlaufmetriken werden automatisch im Run registriert." },
  });
  const compatibilityInventory = await treeInventory(path.join(outputRoot, "runners"));
  await writeJson(outputRoot, "registry/snapshots.json", {
    schemaVersion: 1,
    experimentRunners: {
      source: "public-compatibility-subset", copy: "runners",
      files: compatibilityInventory.files, inventorySha256: compatibilityInventory.sha256,
      algorithm: "SHA-256 over UTF-8 lines '<file-sha256>  <relative-path>\\n', sorted by relative path",
    },
  });
  await writeJson(outputRoot, "distribution/capabilities.json", {
    schemaVersion: 1,
    status: "release-candidate",
    includedExperiments: ["E1", "E2", "E3", "E4", "E5", "E6a", "E6b"],
    defaultSmokeProfile: "profiles/live-smoke.example.json",
    defaultMainPilotProfile: "profiles/live-main-pilot.example.json",
    defaultMainProfile: "profiles/live-main.example.json",
    publicCorporaOnly: true,
    mainRunMetrics: {
      status: "comprehensive-conditional-aggregation",
      table54OperationalMetricsAggregated: true,
      table54Complete: false,
      automatic: [
        "tool-call-rate", "refusal-proxy-rate", "system-failure-rate",
        "model-call-rate", "escalation-rate", "intervention-rate",
        "bypass-rate", "enforcement-rate", "harm-prevention-rate", "fpr",
        "frictionless-execution-rate", "task-success-rate", "approval-load",
        "latency-summaries", "token-summaries", "e6-fidelity", "wilson-95",
      ],
      conditionalOnCorpusPredicates: ["bypass-rate", "harm-prevention-rate", "task-success-rate"],
      conditionalOnRuntimeTelemetry: ["token-summaries"],
      unavailableWithoutAdditionalInstrumentation: ["judge-specific-token-attribution"],
    },
    figureGeneration: "out-of-scope",
  });
  await writeJson(outputRoot, "package.json", {
    name: "guardrail-harness-public-candidate", version: "0.1.0-rc.1", private: true,
    type: "module", scripts: { test: "node --test tests/public-smoke.test.mjs" }, engines: { node: ">=20" },
  });
  await writeFile(path.join(outputRoot, ".gitignore"), [
    "artifacts/runs/*", "!artifacts/runs/.gitkeep", "artifacts/jobs/", "artifacts/locks/",
    "artifacts/metrics/", "runtime/cache/", "runtime/images/", "runtime/packages/", "profiles/local/", "*.log", "*.tmp", "",
  ].join("\n"), "utf8");
  for (const relative of ["artifacts/runs/.gitkeep", "profiles/local/.gitkeep"]) {
    const destination = path.join(outputRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, "", "utf8");
  }

  const forbidden = [
    "runtime/images", "runtime/packages", "runtime/public", "artifacts/jobs", "artifacts/metrics",
    "reference", "notes", "TEMP_KAPITEL4_NOTIZEN.md", "corpora/private", "corpora/custom",
  ];
  const files = await filesBelow(outputRoot);
  const violations = files.filter((file) => forbidden.some((item) => file === item || file.startsWith(`${item}/`)));
  if (violations.length) throw new Error(`Nicht oeffentliche Dateien im Paket: ${violations.join(", ")}`);
  for (const file of files) {
    const content = await readFile(path.join(outputRoot, file));
    const text = content.toString("utf8");
    if (/anurag_maini|infwsn858|gpu-v100s-01/iu.test(text)) {
      throw new Error(`Zielhostspezifischer Wert im oeffentlichen Paket: ${file}`);
    }
  }
  const entries = [];
  let bytes = 0;
  for (const file of files) {
    const info = await stat(path.join(outputRoot, file));
    const digest = await sha256(file, outputRoot);
    bytes += info.size;
    entries.push({ path: file, bytes: info.size, sha256: digest });
  }
  await writeJson(outputRoot, "distribution-manifest.json", {
    schemaVersion: 1, kind: "guardrail-harness-public-candidate", generatedAt: "deterministic-build",
    files: entries.length, bytes, entries,
  });
  return { outputRoot, files: entries.length + 1, bytes };
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const index = process.argv.indexOf("--output");
  const output = index >= 0 ? process.argv[index + 1] : path.join(PUBLIC_ROOT, "guardrail-harness-public");
  if (!output) throw new Error("--output erwartet einen Pfad");
  const result = await buildPublicDistribution(output);
  console.log(`PUBLIC_ROOT=${result.outputRoot}`);
  console.log(`PUBLIC_FILES=${result.files}`);
  console.log(`PUBLIC_SOURCE_BYTES=${result.bytes}`);
}
