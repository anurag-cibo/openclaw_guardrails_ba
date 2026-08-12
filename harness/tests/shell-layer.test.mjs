import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function shellScripts() {
  const found = [];
  for (const directory of ["adapters/live", "bin", "runners"]) {
    for (const entry of await readdir(path.join(ROOT, directory))) {
      const relative = `${directory}/${entry}`;
      const info = await stat(path.join(ROOT, relative));
      if (!info.isFile()) continue;
      if (entry.endsWith(".sh") || entry === "harness") found.push(relative);
    }
  }
  return found.sort();
}

async function sourceFiles() {
  const found = [];
  const walk = async (relative) => {
    for (const entry of await readdir(path.join(ROOT, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (["__pycache__", "node_modules", "research", "local"].includes(entry.name)) continue;
        await walk(next);
      } else if (/\.(mjs|js|sh|json|py)$/u.test(entry.name)) {
        found.push(next);
      }
    }
  };
  for (const directory of ["src", "tests", "adapters", "bin", "runners", "registry", "profiles"]) {
    await walk(directory);
  }
  return found;
}

test("every shell script in the execution path parses", async () => {
  if (process.platform === "win32") return;
  const scripts = await shellScripts();
  assert.ok(scripts.length >= 15, `zu wenige Skripte gefunden: ${scripts.length}`);
  for (const relative of scripts) {
    const result = spawnSync("bash", ["-n", path.join(ROOT, relative)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${relative}: ${result.stderr}`);
  }
});

test("fixture and helper paths used by the live adapters resolve to real files", async () => {
  const adapter = await readFile(path.join(ROOT, "adapters/live/run_e6.sh"), "utf8");
  const fixture = adapter.match(/FIX="\$ROOT\/([^"]+)"/u);
  assert.ok(fixture, "FIX-Zuweisung in run_e6.sh nicht gefunden");
  const fixtureInfo = await stat(path.join(ROOT, fixture[1]));
  assert.ok(fixtureInfo.isDirectory(), `Fixture-Verzeichnis fehlt: ${fixture[1]}`);
  assert.ok((await readdir(path.join(ROOT, fixture[1]))).length >= 4);

  for (const relative of [
    "runners/approval_responder.py",
    "runners/gateway_admin_call.py",
    "runners/evaluate_live_run.py",
    "runners/setup_lab.sh",
    "runners/run_live.sh",
    "runners/run_e6b.sh",
    "adapters/live/wait-gateway-rpc.sh",
  ]) {
    const info = await stat(path.join(ROOT, relative));
    assert.ok(info.isFile(), `fehlt: ${relative}`);
  }
});

test("active runners resolve their fixture path when executed dry", async () => {
  if (process.platform === "win32") return;
  const result = spawnSync("bash", [path.join(ROOT, "runners/run_live.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      DRY_RUN: "1",
      OPENCLAW_REPO: "/tmp/fake-openclaw",
      CORPUS: path.join(ROOT, "corpora/pilot/live.jsonl"),
      OUTDIR: path.join(os.tmpdir(), "harness-dry-fixture"),
      CONFIGS: "C1",
      REPS: "1",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const fixture = result.stdout.match(/FIX='([^']+)'/u);
  assert.ok(fixture, "kein FIX-Aufruf im Dry-Run");
  const info = await stat(fixture[1]);
  assert.ok(info.isDirectory(), `Dry-Run zeigt auf ein fehlendes Fixture-Verzeichnis: ${fixture[1]}`);
});

test("no source file leaks target-host identity or the retired legacy layout", async () => {
  const skip = new Set(["src/tools/build-public-distribution.mjs", "tests/shell-layer.test.mjs"]);
  const offenders = { host: [], legacy: [], windows: [] };
  for (const relative of await sourceFiles()) {
    if (skip.has(relative)) continue;
    const text = await readFile(path.join(ROOT, relative), "utf8");
    if (/anurag_maini|infwsn858|gpu-v100s-01/iu.test(text)) offenders.host.push(relative);
    if (/\blegacy\//u.test(text)) offenders.legacy.push(relative);
    if (/[A-Z]:\\{1,2}Users/u.test(text)) offenders.windows.push(relative);
  }
  assert.deepEqual(offenders.host, [], "Zielhostidentitaet im Quellcode");
  assert.deepEqual(offenders.legacy, [], "veralteter legacy/-Pfad im Quellcode");
  assert.deepEqual(offenders.windows, [], "Windows-Benutzerpfad im Quellcode");
});
