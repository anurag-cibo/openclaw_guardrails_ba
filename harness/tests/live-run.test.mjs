import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeLivePilot, isTransientGatewayFailure, runExperimentPhase } from "../src/lib/live-run.mjs";
import { captureDeployedPluginFingerprint, parseDeployedPluginHashes } from "../src/lib/deployed-plugin.mjs";
import { verifyRunArtifacts } from "../src/lib/run-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("integrated live pilot registers row-checked, hashed artifacts", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-live-"));
  try {
    const fakeRunner = async ({ stage, phase, outputDirectory, resultOutput, logOutput }) => {
      await mkdir(path.join(outputDirectory, "e6_raw"), { recursive: true });
      for (let index = 0; index < phase.expectedRows; index += 1) {
        const row = stage.id === "E6a"
          ? {
              id: `fake-${index}`,
              phase: phase.id,
              e6_arm: ["deny", "allow-once", "timeout", "control_block"][index] ?? "deny",
              tool_called: true,
              e6_valid: true,
              e6_outcome: "valid",
              e6_protected_intact: true,
            }
          : { id: `fake-${index}`, phase: phase.id, tool_called: true, task_success: true, config: "C0" };
        await appendFile(resultOutput, `${JSON.stringify(row)}\n`, "utf8");
      }
      await writeFile(path.join(outputDirectory, "e6_raw", `${phase.id}.json`), "{}\n", "utf8");
      await appendFile(logOutput, `fake phase ${phase.id}\n`, "utf8");
    };
    const run = await executeLivePilot(ROOT, {
      requested: ["E6a"],
      profilePath: "profiles/live-pilot.example.json",
      stateRoot: temporary,
      openclawRepo: "/tmp/openclaw",
      phaseRunner: fakeRunner,
      pluginFingerprintProvider: async () => ({
        schemaVersion: 1,
        pluginId: "guardrail-spike",
        source: "test",
        containerPath: "/fixture",
        files: 1,
        sha256: "0".repeat(64),
        normalizedTextSha256: "0".repeat(64),
        entries: [{ path: "index.js", sha256: "1".repeat(64) }],
      }),
      allowTestBoundary: true,
    });
    assert.equal(run.status.state, "completed");
    assert.equal(run.status.stages[0].status, "succeeded");
    assert.equal(run.manifest.metadata.mainRunAllowed, false);
    assert.equal(run.manifest.metadata.profile.name, "public-example-pilot");
    assert.match(run.manifest.metadata.pilotCompatibility.fingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(run.manifest.metadata.pluginProvenance.deployed.source, "test");
    assert.equal(run.manifest.metadata.pluginProvenance.byteIdenticalToMeasurementBaseline, false);
    assert.equal(run.manifest.metadata.pluginProvenance.matchesMeasurementBaseline, false);
    assert.equal(run.status.stages[0].artifacts.some((item) => item.role === "raw-capture"), true);
    assert.deepEqual(run.status.artifacts.map((item) => item.role), [
      "input-profile", "input-corpus-live", "input-corpus-approval",
    ]);
    assert.equal(
      await readFile(path.join(run.paths.inputs, "profile.json"), "utf8"),
      await readFile(path.join(ROOT, "profiles/live-pilot.example.json"), "utf8"),
    );
    assert.deepEqual(await verifyRunArtifacts(temporary, run.status.runId), { ok: true, checked: 7, errors: [] });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("compact live main requires and accepts only a matching completed pilot", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-live-main-"));
  const pluginFingerprint = async () => ({
    schemaVersion: 1,
    pluginId: "guardrail-spike",
    source: "test",
    containerPath: "/fixture",
    files: 1,
    sha256: "0".repeat(64),
    normalizedTextSha256: "1".repeat(64),
    entries: [{ path: "index.js", sha256: "0".repeat(64), normalizedTextSha256: "1".repeat(64) }],
  });
  const fakeRunner = async ({ stage, phase, outputDirectory, resultOutput, logOutput }) => {
    await mkdir(outputDirectory, { recursive: true });
    for (let index = 0; index < phase.expectedRows; index += 1) {
      const row = stage.id === "E6a"
        ? {
            id: `main-${index}`,
            e6_arm: ["deny", "allow-once", "timeout", "control_block"][index] ?? "deny",
            tool_called: true,
            e6_valid: true,
            e6_outcome: "valid",
            e6_protected_intact: true,
          }
        : { id: `main-${index}`, config: "C0", tool_called: true, task_success: true };
      await appendFile(resultOutput, `${JSON.stringify(row)}\n`, "utf8");
    }
    await appendFile(logOutput, `fake ${stage.id}\n`, "utf8");
    return { attempts: 1 };
  };
  try {
    await assert.rejects(executeLivePilot(ROOT, {
      kind: "main",
      profilePath: "profiles/live-main.example.json",
      stateRoot: temporary,
      openclawRepo: "/tmp/openclaw",
      phaseRunner: fakeRunner,
      pluginFingerprintProvider: pluginFingerprint,
      allowTestBoundary: true,
    }), /--pilot-run/u);

    const pilot = await executeLivePilot(ROOT, {
      profilePath: "profiles/live-main-pilot.example.json",
      stateRoot: temporary,
      openclawRepo: "/tmp/openclaw",
      phaseRunner: fakeRunner,
      pluginFingerprintProvider: pluginFingerprint,
      allowTestBoundary: true,
    });
    await assert.rejects(executeLivePilot(ROOT, {
      kind: "main",
      requested: ["E6a"],
      profilePath: "profiles/live-main.example.json",
      pilotRunId: pilot.status.runId,
      stateRoot: temporary,
      openclawRepo: "/tmp/openclaw",
      phaseRunner: fakeRunner,
      pluginFingerprintProvider: pluginFingerprint,
      allowTestBoundary: true,
    }), /passt nicht zum Main-Vertrag/u);
    const main = await executeLivePilot(ROOT, {
      kind: "main",
      profilePath: "profiles/live-main.example.json",
      pilotRunId: pilot.status.runId,
      stateRoot: temporary,
      openclawRepo: "/tmp/openclaw",
      phaseRunner: fakeRunner,
      pluginFingerprintProvider: pluginFingerprint,
      allowTestBoundary: true,
    });
    assert.equal(main.status.kind, "main");
    assert.equal(main.status.state, "completed");
    assert.equal(main.manifest.metadata.mainRunAllowed, true);
    assert.equal(main.manifest.metadata.pilotQualification.status, "passed");
    assert.equal(main.manifest.metadata.pilotQualification.pilotRunId, pilot.status.runId);
    assert.equal(main.status.artifacts.some((item) => item.role === "run-metrics"), true);
    const metrics = JSON.parse(await readFile(path.join(main.paths.derived, "metrics.bundle.json"), "utf8"));
    assert.equal(metrics.finalEligibility.eligibleAsNewHarnessMainRun, true);
    assert.equal(metrics.scope.expectedRows, 20);
    assert.equal(metrics.scope.observedRows, 20);
    assert.equal(metrics.provenance.pilotRunId, pilot.status.runId);
    assert.equal(metrics.schemaVersion, 2);
    assert.deepEqual(metrics.provenance.inputSnapshots.map((item) => item.role), [
      "input-profile", "input-corpus-live", "input-corpus-approval",
    ]);
    assert.equal(metrics.validation.inputSnapshotsRegistered, true);
    assert.deepEqual(await verifyRunArtifacts(temporary, main.status.runId), { ok: true, checked: 10, errors: [] });
    const metricsCli = spawnSync(process.execPath, [
      path.join(ROOT, "src", "cli.mjs"), "metrics", "run", main.status.runId,
    ], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_STATE_ROOT: temporary },
      shell: false,
    });
    assert.equal(metricsCli.status, 0, metricsCli.stderr);
    assert.match(metricsCli.stdout, /derived[\\/]metrics\.bundle\.json/u);
    assert.match(metricsCli.stdout, /freigegeben fuer den exakt dokumentierten Profilumfang|freigegeben für den exakt dokumentierten Profilumfang/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("deployed plugin fingerprint parser is deterministic and rejects incomplete output", () => {
  const indexHash = "1".repeat(64);
  const manifestHash = "2".repeat(64);
  const packageHash = "3".repeat(64);
  const sourceHash = "4".repeat(64);
  const first = parseDeployedPluginHashes([
    `${sourceHash}  src/index.js`,
    `${packageHash}  package.json`,
    `${indexHash}  index.js`,
    `${manifestHash}  openclaw.plugin.json`,
  ].join("\n"));
  const second = parseDeployedPluginHashes([
    `${manifestHash}  openclaw.plugin.json`,
    `${indexHash}  index.js`,
    `${sourceHash}  src/index.js`,
    `${packageHash}  package.json`,
  ].join("\n"));
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.normalizedTextSha256, second.normalizedTextSha256);
  assert.equal(first.files, 4);
  assert.throws(
    () => parseDeployedPluginHashes(`${indexHash}  index.js\n${sourceHash}  src/index.js`),
    /Pflichtdatei fehlt/u,
  );
});

test("deployed plugin fingerprint separates byte and normalized text hashes", () => {
  const raw = "a".repeat(64);
  const normalized = "b".repeat(64);
  const fixed = [
    `${raw}  ${normalized}  index.js`,
    `${raw}  ${normalized}  openclaw.plugin.json`,
    `${raw}  ${normalized}  package.json`,
    `${raw}  ${normalized}  src/index.js`,
  ].join("\n");
  const parsed = parseDeployedPluginHashes(fixed);
  assert.notEqual(parsed.sha256, parsed.normalizedTextSha256);
  assert.equal(parsed.entries.every((entry) => entry.normalizedTextSha256 === normalized), true);
});

test("deployed plugin capture requests raw and LF-normalized hashes read-only", () => {
  const raw = "a".repeat(64);
  const normalized = "b".repeat(64);
  let invocation;
  const result = captureDeployedPluginFingerprint("/srv/openclaw", {
    commandRunner(command, args, options) {
      invocation = { command, args, options };
      return {
        status: 0,
        stdout: ["index.js", "openclaw.plugin.json", "package.json", "src/index.js"]
          .map((file) => `${raw}  ${normalized}  ${file}`).join("\n"),
        stderr: "",
      };
    },
  });
  assert.equal(invocation.command, "docker");
  assert.match(invocation.args.at(-1), /readFileSync/u);
  assert.match(invocation.args.at(-1), /replace\(\/\\r\\n\/g/u);
  assert.equal(invocation.options.shell, false);
  assert.equal(result.entries.every((entry) => entry.normalizedTextSha256 === normalized), true);
});

test("live pilot refuses execution outside host-runner boundary", async () => {
  await assert.rejects(executeLivePilot(ROOT, { requested: ["E5"], openclawRepo: "/tmp/openclaw" }), /Host-Runner-Grenze/u);
});

test("gateway readiness failures are classified narrowly", () => {
  assert.equal(isTransientGatewayFailure("GatewayTransportError: gateway closed (1006 abnormal closure (no close frame))"), true);
  assert.equal(isTransientGatewayFailure("fachlicher Evaluatorfehler"), false);
});

test("Gateway readiness probe passes one exact empty JSON object and retries", async () => {
  if (process.platform === "win32") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-gateway-ready-"));
  try {
    const caller = path.join(temporary, "fake_gateway_call.py");
    const counter = path.join(temporary, "attempts");
    await writeFile(caller, `#!/usr/bin/env python3
import json,pathlib,sys
values=dict(zip(sys.argv[1::2], sys.argv[2::2]))
payload=values["--params"]
assert payload == "{}", repr(payload)
assert json.loads(payload) == {}
counter=pathlib.Path(values["--openclaw-repo"])
attempt=int(counter.read_text() if counter.exists() else "0") + 1
counter.write_text(str(attempt))
raise SystemExit(0 if attempt >= 2 else 1)
`, "utf8");
    const helper = path.join(ROOT, "adapters/live/wait-gateway-rpc.sh");
    const result = spawnSync("bash", [helper, caller, counter], {
      encoding: "utf8",
      env: {
        ...process.env,
        GATEWAY_READY_ATTEMPTS: "2",
        GATEWAY_READY_INTERVAL_SECONDS: "0.01",
        GATEWAY_READY_TIMEOUT_SECONDS: "1",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(counter, "utf8"), "2");
    assert.match(result.stdout, /Gateway-RPC bereit \(Probe 2\/2\)/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("live runners call the gateway readiness probe instead of a fixed wait", async () => {
  if (process.platform === "win32") return;
  const cases = [
    ["runners/run_live.sh", "corpora/pilot/live.jsonl", "live"],
    ["runners/run_e6b.sh", "corpora/pilot/approval.jsonl", "e6b"],
  ];
  for (const [runner, corpus, label] of cases) {
    const result = spawnSync("bash", [path.join(ROOT, runner)], {
      encoding: "utf8",
      env: {
        ...process.env,
        DRY_RUN: "1",
        OPENCLAW_REPO: "/tmp/fake-openclaw",
        CORPUS: path.join(ROOT, corpus),
        OUTDIR: path.join(os.tmpdir(), `harness-dry-${label}`),
      },
    });
    assert.equal(result.status, 0, `${runner}: ${result.stderr}`);
    assert.match(result.stdout, /warte auf Gateway-RPC-Bereitschaft/u);
    assert.doesNotMatch(result.stdout, /\+ sleep 6/u);
  }
});

test("experiment phase retries a transient gateway startup race and cleans its attempt output", async () => {
  if (process.platform === "win32") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-live-retry-"));
  try {
    const script = path.join(temporary, "retry-fixture.sh");
    const attemptsFile = path.join(temporary, "attempts");
    const outputDirectory = path.join(temporary, "output");
    const logOutput = path.join(temporary, "phase.log");
    await mkdir(outputDirectory);
    await writeFile(script, `#!/usr/bin/env bash\nset -eu\nn=0\n[ ! -f '${attemptsFile}' ] || n=$(cat '${attemptsFile}')\nn=$((n+1))\nprintf '%s\\n' "$n" > '${attemptsFile}'\nif [ "$n" -eq 1 ]; then\n  printf 'stale\\n' > '${path.join(outputDirectory, "stale.txt")}'\n  echo 'GatewayTransportError: gateway closed (1006 abnormal closure (no close frame))' >&2\n  exit 1\nfi\nprintf 'fresh\\n' > '${path.join(outputDirectory, "fresh.txt")}'\n`, "utf8");
    const result = await runExperimentPhase({
      codeRoot: temporary,
      stage: { id: "E6a" },
      phase: { id: "pilot", script: "retry-fixture.sh", environment: {}, maxAttempts: 2, retryDelayMs: 1 },
      environment: {},
      logOutput,
      outputDirectory,
    });
    assert.equal(result.attempts, 2);
    assert.equal(await readFile(path.join(outputDirectory, "fresh.txt"), "utf8"), "fresh\n");
    await assert.rejects(readFile(path.join(outputDirectory, "stale.txt"), "utf8"));
    assert.match(await readFile(logOutput, "utf8"), /\[RETRY\]/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
