import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const VALID_RUNNERS = new Set(["policy", "judge", "latency", "live", "approval", "analysis"]);

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function loadRegistries(root) {
  const registry = path.join(root, "registry");
  const [experiments, corpora, analysis, snapshots] = await Promise.all([
    readJson(path.join(registry, "experiments.json")),
    readJson(path.join(registry, "corpora.json")),
    readJson(path.join(registry, "analysis.json")),
    readJson(path.join(registry, "snapshots.json")),
  ]);
  return { experiments, corpora, analysis, snapshots };
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

export async function validateRegistries(root, registries) {
  const errors = [];
  const { experiments, corpora, analysis } = registries;
  assert(experiments.schemaVersion === 1, "experiments.json: unsupported schemaVersion", errors);
  assert(corpora.schemaVersion === 1, "corpora.json: unsupported schemaVersion", errors);
  assert(analysis.schemaVersion === 1, "analysis.json: unsupported schemaVersion", errors);

  const ids = Object.keys(experiments.experiments ?? {});
  const order = experiments.canonicalOrder ?? [];
  assert(new Set(order).size === order.length, "canonicalOrder contains duplicates", errors);
  assert(ids.length === order.length, "canonicalOrder and experiments differ in size", errors);
  for (const id of ids) assert(order.includes(id), `experiment ${id} missing in canonicalOrder`, errors);

  for (const id of order) {
    const experiment = experiments.experiments[id];
    assert(Boolean(experiment), `canonical experiment ${id} is undefined`, errors);
    if (!experiment) continue;
    assert(VALID_RUNNERS.has(experiment.runner), `${id}: invalid runner ${experiment.runner}`, errors);
    if (!experiment.derived) {
      assert(Boolean(experiment.corpus), `${id}: corpus missing`, errors);
      assert(Boolean(corpora.corpora?.[experiment.corpus]), `${id}: unknown corpus ${experiment.corpus}`, errors);
      assert(Boolean(experiment.adapter), `${id}: adapter missing`, errors);
      if (experiment.adapter) {
        try {
          const info = await stat(path.join(root, experiment.adapter));
          assert(info.isFile(), `${id}: adapter is not a file: ${experiment.adapter}`, errors);
        } catch {
          errors.push(`${id}: adapter missing: ${experiment.adapter}`);
        }
      }
    }
  }

  for (const [id, corpus] of Object.entries(corpora.corpora ?? {})) {
    assert(Number.isInteger(corpus.cases) && corpus.cases > 0, `${id}: cases must be a positive integer`, errors);
    const paths = corpus.paths ?? [corpus.path];
    for (const relative of paths) {
      assert(Boolean(relative), `${id}: corpus path missing`, errors);
      if (!relative) continue;
      try {
        const info = await stat(path.join(root, relative));
        assert(info.isFile(), `${id}: not a file: ${relative}`, errors);
      } catch {
        errors.push(`${id}: file missing: ${relative}`);
      }
    }
  }

  for (const component of analysis.components ?? []) {
    try {
      const info = await stat(path.join(root, component.component));
      assert(info.isFile(), `analysis component is not a file: ${component.component}`, errors);
    } catch {
      errors.push(`analysis component missing: ${component.component}`);
    }
  }

  return errors;
}

async function filesBelow(root, current = root) {
  const out = [];
  for (const item of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, item.name);
    if (item.isDirectory()) out.push(...await filesBelow(root, absolute));
    else if (item.isFile()) out.push(absolute);
  }
  return out;
}

export async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function treeInventory(root) {
  const files = (await filesBelow(root))
    .map((file) => ({
      file,
      relative: path.relative(root, file).split(path.sep).join("/"),
    }))
    .sort((left, right) => left.relative.localeCompare(right.relative, "en"));
  const rows = [];
  for (const item of files) {
    rows.push(`${await sha256File(item.file)}  ${item.relative}`);
  }
  const payload = `${rows.join("\n")}\n`;
  return {
    files: rows.length,
    sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
    rows,
  };
}

export async function verifyCorpusHashes(root, registries) {
  const errors = [];
  for (const [id, corpus] of Object.entries(registries.corpora.corpora)) {
    if (typeof corpus.sha256 === "string" && corpus.path) {
      const actual = await sha256File(path.join(root, corpus.path));
      if (actual !== corpus.sha256) errors.push(`${id}: SHA-256 mismatch`);
    } else if (corpus.sha256 && corpus.paths) {
      const labels = Object.keys(corpus.sha256);
      for (let index = 0; index < corpus.paths.length; index += 1) {
        const label = labels[index];
        const actual = await sha256File(path.join(root, corpus.paths[index]));
        if (actual !== corpus.sha256[label]) errors.push(`${id}/${label}: SHA-256 mismatch`);
      }
    }
  }
  return errors;
}
