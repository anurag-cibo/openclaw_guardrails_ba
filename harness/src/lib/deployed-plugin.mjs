import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const PLUGIN_CONTAINER_PATH = "/home/node/.openclaw/local-plugins/guardrail-spike";
const FIXED_CORE_FILES = Object.freeze(["index.js", "openclaw.plugin.json", "package.json"]);

function combinedDigest(entries) {
  const canonical = entries
    .map(({ path: relative, sha256, normalizedTextSha256 = sha256 }) => ({
      path: relative,
      sha256,
      normalizedTextSha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const byteInput = canonical.map((entry) => `${entry.sha256}  ${entry.path}\n`).join("");
  const normalizedInput = canonical.map((entry) => `${entry.normalizedTextSha256}  ${entry.path}\n`).join("");
  return {
    schemaVersion: 1,
    files: canonical.length,
    sha256: createHash("sha256").update(byteInput, "utf8").digest("hex"),
    normalizedTextSha256: createHash("sha256").update(normalizedInput, "utf8").digest("hex"),
    entries: canonical,
  };
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function filesBelow(directory, relativeRoot = directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(absolute, relativeRoot));
    else if (entry.isFile()) output.push(path.relative(relativeRoot, absolute).split(path.sep).join("/"));
  }
  return output;
}

export async function fingerprintPluginCore(directory) {
  const srcFiles = (await filesBelow(path.join(directory, "src")))
    .map((relative) => `src/${relative}`);
  const files = [...FIXED_CORE_FILES, ...srcFiles].sort((left, right) => left.localeCompare(right, "en"));
  const entries = [];
  for (const relative of files) {
    const content = await readFile(path.join(directory, ...relative.split("/")));
    const normalized = Buffer.from(content.toString("utf8").replace(/\r\n/gu, "\n"), "utf8");
    entries.push({ path: relative, sha256: digest(content), normalizedTextSha256: digest(normalized) });
  }
  return { ...combinedDigest(entries), source: "filesystem-core" };
}

export function parseDeployedPluginHashes(output) {
  const entries = String(output).split(/\r?\n/u).filter((line) => line.trim()).map((line) => {
    const normalizedMatch = /^([a-f0-9]{64})[ \t]+([a-f0-9]{64})[ \t]+(.+)$/u.exec(line.trim());
    const rawMatch = /^([a-f0-9]{64})[ \t]+(.+)$/u.exec(line.trim());
    const match = normalizedMatch ?? rawMatch;
    if (!match) throw new Error(`Deployter Plugin-Fingerprint: ungueltige sha256sum-Zeile: ${line}`);
    const relative = match[normalizedMatch ? 3 : 2].replace(/^\.\//u, "");
    if (path.posix.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) {
      throw new Error(`Deployter Plugin-Fingerprint: unzulaessiger Pfad: ${relative}`);
    }
    return {
      path: relative,
      sha256: match[1],
      normalizedTextSha256: normalizedMatch ? match[2] : match[1],
    };
  });
  const paths = new Set(entries.map((entry) => entry.path));
  for (const required of FIXED_CORE_FILES) {
    if (!paths.has(required)) throw new Error(`Deployter Plugin-Fingerprint: Pflichtdatei fehlt: ${required}`);
  }
  if (![...paths].some((relative) => relative.startsWith("src/"))) {
    throw new Error("Deployter Plugin-Fingerprint: keine Quelldatei unter src/ gefunden");
  }
  if (paths.size !== entries.length) throw new Error("Deployter Plugin-Fingerprint: doppelte Dateipfade");
  return combinedDigest(entries);
}

export function captureDeployedPluginFingerprint(openclawRepo, { commandRunner = spawnSync } = {}) {
  const compose = [
    "compose",
    "-f", path.join(openclawRepo, "docker-compose.yml"),
    "-f", path.join(openclawRepo, "docker-compose.ollama.override.yml"),
    "exec", "-T", "openclaw-gateway", "sh", "-lc",
  ];
  const script = `set -eu
cd '${PLUGIN_CONTAINER_PATH}'
for required in index.js openclaw.plugin.json package.json src; do test -e "$required"; done
{ printf '%s\\n' index.js openclaw.plugin.json package.json; find src -type f -print; } |
  LC_ALL=C sort -u |
  while IFS= read -r file; do
    raw="$(sha256sum "$file" | awk '{print $1}')"
    normalized="$(node -e 'const fs=require("fs"),c=require("crypto"),b=fs.readFileSync(process.argv[1]),t=b.toString("utf8").replace(/\\r\\n/g,"\\n");process.stdout.write(c.createHash("sha256").update(t,"utf8").digest("hex"))' "$file")"
    printf '%s  %s  %s\\n' "$raw" "$normalized" "$file"
  done`;
  const result = commandRunner("docker", [...compose, script], { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || "unbekannter Fehler").trim();
    throw new Error(`Deployter Plugin-Fingerprint konnte nicht gelesen werden: ${detail}`);
  }
  return {
    ...parseDeployedPluginHashes(result.stdout),
    pluginId: "guardrail-spike",
    source: "deployed-gateway-core",
    containerPath: PLUGIN_CONTAINER_PATH,
  };
}
