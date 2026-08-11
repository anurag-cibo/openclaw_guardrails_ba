import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function text(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

test("runtime lock pins the base digest and locally validated image ID", async () => {
  const lock = JSON.parse(await text("runtime/image-lock.json"));
  assert.equal(lock.status, "target-preflight-validated");
  assert.match(lock.controlRuntime.baseImageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(lock.controlRuntime.builtImageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(lock.controlRuntime.targetImportedImageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(lock.localValidation.containerDoctorPassed, true);
  assert.equal(lock.localValidation.targetHostValidated, true);
  assert.equal(lock.localValidation.targetHostValidation.preflightPassed, true);

  const pinnedBase = `${lock.controlRuntime.baseImage}@${lock.controlRuntime.baseImageDigest}`;
  assert.match(await text("runtime/Dockerfile"), new RegExp(`ARG BASE_IMAGE=${pinnedBase}`));
  assert.match(await text("runtime/compose.yaml"), new RegExp(`BASE_IMAGE: ${pinnedBase}`));
});

test("host wrapper binds host ownership and rejects an unexpected image", async () => {
  const wrapper = await text("bin/harness");
  const jobs = await text("bin/job-control.sh");
  assert.match(wrapper, /HARNESS_UID=.*id -u/);
  assert.match(wrapper, /HARNESS_GID=.*id -g/);
  assert.match(wrapper, /targetImportedImageId/);
  assert.match(wrapper, /verify_runtime_image/);
  assert.match(wrapper, /image_matches_locked_id/);
  assert.match(wrapper, /live:pilot\|live:main/);
  assert.match(wrapper, /launch live main/);
  assert.match(jobs, /nohup setsid bash/);
  assert.match(jobs, /exit-code/);
  assert.match(jobs, /tail -n 50 -f/);
});

test("control container stays offline and has no Docker socket mount", async () => {
  const compose = await text("runtime/compose.yaml");
  const judgeCompose = await text("runtime/judge.compose.yaml");
  const liveCompose = await text("runtime/live.compose.yaml");
  assert.match(compose, /network_mode:\s*none/);
  assert.match(compose, /user:\s*"\$\{HARNESS_UID:-1000\}:\$\{HARNESS_GID:-1000\}"/);
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.doesNotMatch(compose, /openclaw_default/);
  assert.match(compose, /target:\s*\/harness-data[\s\S]*read_only:\s*true/u);
  assert.match(compose, /HARNESS_DATA_ROOT:\s*\/harness-data/u);
  assert.match(judgeCompose, /judge:\s*[\s\S]*networks:\s*\n\s*- judge-network/);
  assert.match(judgeCompose, /name:\s*"\$\{HARNESS_JUDGE_NETWORK:-openclaw_default\}"/);
  assert.match(liveCompose, /host-runner:/);
  assert.match(liveCompose, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(liveCompose, /network_mode:\s*none/);
  assert.match(liveCompose, /HARNESS_DOCKER_GID/);
  assert.match(liveCompose, /target:\s*\/harness-data[\s\S]*read_only:\s*true/u);
});

test("host runner pins Docker CLI and makes the socket boundary explicit", async () => {
  const lock = JSON.parse(await text("runtime/host-runner-lock.json"));
  const dockerfile = await text("runtime/HostRunner.Dockerfile");
  const preflight = await text("bin/target-preflight.sh");
  assert.equal(lock.status, "haw-preflight-validated");
  assert.match(lock.builtImageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(lock.targetImportedImageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(lock.localValidation.targetHostValidated, true);
  assert.match(lock.dockerCli.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(dockerfile, new RegExp(`docker:24\\.0\\.6-cli@${lock.dockerCli.digest}`));
  assert.match(lock.securityBoundary, /Host-Rechten/);
  assert.match(preflight, /read-only/);
  assert.match(preflight, /openclaw-gateway/);
  assert.match(preflight, /Ollama-Modell/);
  assert.match(preflight, /Imagearchiv stimmt per SHA-256/);
  assert.match(preflight, /Imagearchiv fehlt; Laufzeitidentitaet wird anhand der zuvor validierten HAW-Import-ID geprueft/u);
  assert.match(preflight, /stimmt mit der in der Lockdatei zuvor validierten HAW-Import-ID überein/u);
  assert.match(preflight, /vorhandene Exportarchiv ist nicht verifiziert/u);
});

test("live host wrapper resolves profile models before target preflight", async () => {
  const wrapper = await readFile(path.join(ROOT, "bin/live-pilot.sh"), "utf8");
  assert.match(wrapper, /control profile models/u);
  assert.match(wrapper, /export MODEL=/u);
  assert.match(wrapper, /bash "\$ROOT\/bin\/target-preflight\.sh"/u);
  assert.equal(wrapper.indexOf("control profile models") < wrapper.indexOf("target-preflight.sh"), true);
});

test("live plugin-info uses the read-only preflight and host-runner boundary", async () => {
  const wrapper = await text("bin/harness");
  assert.match(wrapper, /subcommand" = "plugin-info"/u);
  assert.match(wrapper, /bash "\$ROOT\/bin\/target-preflight\.sh"/u);
  assert.match(wrapper, /run --rm host-runner "\$@"/u);
});

test("image identity degrades to the locked runtime versions instead of failing", async () => {
  const wrapper = await text("bin/harness");
  // Die Docker-Image-ID ist nicht versionsstabil. Weicht sie ab, muss der
  // inhaltliche Nachweis entscheiden statt eines harten Abbruchs.
  assert.match(wrapper, /node --version; python3 --version/u);
  assert.match(wrapper, /weder der gelockten ID noch den gelockten Laufzeitversionen/u);
  assert.match(wrapper, /abweichende Docker-ID/u);
  assert.match(wrapper, /docker --version/u);
});

test("runtime-build refuses to overwrite an image that already matches the lock", async () => {
  const wrapper = await text("bin/harness");
  assert.match(wrapper, /FORCE_BUILD/u);
  assert.match(wrapper, /runtime-build --force/u);
  assert.match(wrapper, /containerd-Image-Store ist das alte Image danach geloescht/u);
  // Der Schutz muss vor dem Bauen greifen, nicht danach.
  const guard = wrapper.indexOf("ABBRUCH] Es liegt bereits ein gegen den Lock validiertes Image vor");
  const build = wrapper.indexOf('build control "$@"');
  assert.ok(guard > 0 && build > guard, "Schutzabfrage steht nicht vor dem Build");
});

test("the E6a driver restores its flag verifiably and on signals", async () => {
  const adapter = await text("adapters/live/run_e6.sh");
  assert.match(adapter, /trap restore_e6_harness_tool EXIT INT TERM/u);
  assert.match(adapter, /normalize_bool/u);
  assert.match(adapter, /WARNUNG\] Testtreiber konnte nicht zurueckgesetzt werden/u);
  // Der Zustand muss nach dem Zuruecksetzen erneut gelesen und verglichen werden.
  const restore = adapter.slice(adapter.indexOf("restore_e6_harness_tool() {"));
  assert.match(restore, /actual="\$\(read_e6_harness_flag\)"/u);
});
