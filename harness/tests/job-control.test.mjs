import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("background job survives its launcher and records exit status and log", {
  skip: process.platform === "win32" ? "Linux/Bash contract is tested in the control container" : false,
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-jobs-"));
  try {
    const script = path.join(ROOT, "bin/job-control.sh");
    const launch = spawnSync("bash", [script, "launch", temporary, "bash", "-c", "printf 'detached-ok\\n'"], { encoding: "utf8" });
    assert.equal(launch.status, 0, launch.stderr);
    const jobId = /^Job:\s+(\S+)$/mu.exec(launch.stdout)?.[1];
    assert.ok(jobId);
    const jobDirectory = path.join(temporary, jobId);
    let exitCode = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      exitCode = await readFile(path.join(jobDirectory, "exit-code"), "utf8").catch(() => null);
      if (exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(exitCode?.trim(), "0");
    assert.match(await readFile(path.join(jobDirectory, "console.log"), "utf8"), /detached-ok/u);
    const status = spawnSync("bash", [script, "status", temporary, jobId], { encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Status:\s+completed/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("live lock rejects a concurrent runner and releases automatically", {
  skip: process.platform === "win32" ? "Linux/flock contract is tested in the control container" : false,
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-live-lock-"));
  try {
    const script = path.join(ROOT, "bin/live-lock.sh");
    const ready = path.join(temporary, "ready");
    const first = spawn("bash", [script, temporary, "bash", "-c", `printf ready > '${ready}'; sleep 0.5`], {
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await readFile(ready, "utf8").catch(() => null)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const concurrent = spawnSync("bash", [script, temporary, "bash", "-c", "exit 0"], { encoding: "utf8" });
    assert.equal(concurrent.status, 4, concurrent.stderr);
    assert.match(concurrent.stderr, /bereits ein Live-\/Approval-Job/u);
    await new Promise((resolve, reject) => {
      first.once("error", reject);
      first.once("close", resolve);
    });
    const after = spawnSync("bash", [script, temporary, "bash", "-c", "exit 0"], { encoding: "utf8" });
    assert.equal(after.status, 0, after.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
