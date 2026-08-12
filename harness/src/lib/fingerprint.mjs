import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJson } from "./json.mjs";
import { sha256File, treeInventory } from "./registry.mjs";

export function digestObject(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

async function hashRegisteredCorpus(root, corpus) {
  const paths = corpus.paths ?? [corpus.path];
  const output = {};
  for (let index = 0; index < paths.length; index += 1) {
    const label = corpus.paths ? Object.keys(corpus.sha256)[index] : "primary";
    output[label] = {
      path: paths[index],
      sha256: await sha256File(path.join(root, paths[index])),
    };
  }
  return output;
}

export async function buildFingerprints(root, registries, plan, runKind, options = {}) {
  const experimentIds = plan.map((stage) => stage.id);
  const adapterPaths = [...new Set(experimentIds
    .map((id) => registries.experiments.experiments[id]?.adapter)
    .filter(Boolean))].sort();
  const corpusIds = [...new Set(experimentIds
    .map((id) => registries.experiments.experiments[id]?.corpus)
    .filter(Boolean))].sort();

  const adapters = {};
  for (const adapter of adapterPaths) {
    adapters[adapter] = await sha256File(path.join(root, adapter));
  }

  const corpora = {};
  for (const id of corpusIds) {
    corpora[id] = await hashRegisteredCorpus(root, registries.corpora.corpora[id]);
  }

  const registryFiles = {};
  for (const name of [
    "experiments.json",
    "corpora.json",
    "analysis.json",
    "snapshots.json",
    "corpus-case.schema.json",
  ]) {
    registryFiles[name] = await sha256File(path.join(root, "registry", name));
  }

  const [plugin, control, runtimeAdapters] = await Promise.all([
    treeInventory(path.join(root, "vendor", "plugin-baseline")),
    treeInventory(path.join(root, "src")),
    treeInventory(path.join(root, "adapters")),
  ]);
  const runtimeLock = path.join(root, "runtime", "image-lock.json");

  const environment = {
    schemaVersion: 1,
    experimentIds,
    registries: registryFiles,
    adapters,
    corpora,
    plugin: { files: plugin.files, sha256: plugin.sha256 },
    control: { files: control.files, sha256: control.sha256 },
    runtimeAdapters: { files: runtimeAdapters.files, sha256: runtimeAdapters.sha256 },
    runtimeLock: await sha256File(runtimeLock),
    models: options.models ?? {},
    configuration: options.configuration ?? {},
  };
  const environmentFingerprint = digestObject(environment);
  const execution = {
    schemaVersion: 1,
    environmentFingerprint,
    runKind,
    plan,
  };
  return {
    environmentFingerprint,
    executionFingerprint: digestObject(execution),
    components: environment,
  };
}
