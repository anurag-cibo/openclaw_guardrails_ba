export function selectExperiments(registry, requested) {
  const { canonicalOrder, experiments } = registry;
  if (requested.length === 0 || requested.includes("--all")) return [...canonicalOrder];
  const unknown = requested.filter((id) => !experiments[id]);
  if (unknown.length) throw new Error(`Unbekannte Experiment-ID(s): ${unknown.join(", ")}`);
  return canonicalOrder.filter((id) => requested.includes(id));
}

export function makePlan(registry, selected, pilot = false) {
  return selected.map((id, index) => {
    const experiment = registry.experiments[id];
    return {
      order: index + 1,
      id,
      title: experiment.title,
      runner: experiment.runner,
      level: experiment.level,
      corpus: experiment.corpus ?? null,
      mode: pilot ? "pilot" : "full",
      parameters: pilot
        ? (experiment.pilot ?? { derived: true })
        : (experiment.run ?? experiment.expected ?? { derived: true }),
    };
  });
}
