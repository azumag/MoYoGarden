#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, writeSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { auditEvolutionEngine, withProductionIoGuard } from "./evolution-isolation.mjs";
export { withProductionIoGuard } from "./evolution-isolation.mjs";

const engine = auditEvolutionEngine();
const [{ normalizedHeritableTraits, POPULATION_TRAIT_MIN, POPULATION_TRAIT_MAX, POPULATION_DAY_TICKS,
  POPULATION_ELDER_AGE_TICKS, POPULATION_MIN_LIFESPAN_TICKS, POPULATION_MAX_LIFESPAN_TICKS },
  { DEFAULT_SIMULATION_CONFIG }, { WorldRuntime }, { createInitialWorld }] = await withProductionIoGuard(() => Promise.all([
  import("../dist-ts/src/demography.js"), import("../dist-ts/src/protocol.js"),
  import("../dist-ts/src/runtime.js"), import("../dist-ts/src/world.js"),
]));

const ARTIFACT_SCHEMA_VERSION = 1;
const DEFAULT_SEED = 3902;
const DEFAULT_TICKS = 100_000;
const DEFAULT_SAMPLE_EVERY = 8_640;


function finiteInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return parsed;
}

function rounded(value, digits = 12) {
  if (value === null) return null;
  if (!Number.isFinite(value)) throw new Error("non-finite canary metric");
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function percentile(sortedValues, quantile) {
  if (sortedValues.length === 0) return 0;
  const index = Math.round((sortedValues.length - 1) * quantile);
  return sortedValues[index] ?? 0;
}

function distribution(values) {
  if (values.length === 0) {
    return { count: 0, mean: null, min: null, max: null, variance: null, p10: null, p50: null, p90: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    mean: rounded(mean),
    min: rounded(sorted[0] ?? 0),
    max: rounded(sorted.at(-1) ?? 0),
    variance: rounded(variance),
    p10: rounded(percentile(sorted, 0.1)),
    p50: rounded(percentile(sorted, 0.5)),
    p90: rounded(percentile(sorted, 0.9)),
  };
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

function stageOf(agent) {
  return agent.lifeStage ?? "adult";
}

function traitMetrics(agents) {
  const normalized = agents.map((agent) => normalizedHeritableTraits(agent));
  return {
    founderCount: agents.filter((agent) => agent.parents === undefined).length,
    lineageBornCount: agents.filter((agent) => agent.parents !== undefined).length,
    vitality: distribution(normalized.map((traits) => traits.vitality)),
    carryingCapacity: distribution(normalized.map((traits) => traits.carryingCapacity)),
  };
}

function environmentMetrics(state) {
  const depositAmounts = { food: 0, stone: 0, wood: 0 };
  const activeDepositCounts = { food: 0, stone: 0, wood: 0 };
  let depletedDepositCount = 0;
  for (const tile of state.tiles) {
    if (tile.resource === undefined) continue;
    depositAmounts[tile.resource.kind] += tile.resource.amount;
    if (tile.resource.amount > 0) activeDepositCounts[tile.resource.kind] += 1;
    else depletedDepositCount += 1;
  }

  const resourceLayoutHash = sha256(state.tiles.map((tile) => ({
    x: tile.x,
    y: tile.y,
    terrain: tile.terrain,
    resource: tile.resource === undefined
      ? null
      : { kind: tile.resource.kind, amount: tile.resource.amount, maxAmount: tile.resource.maxAmount },
  })));

  return {
    factionResources: [...state.factions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((faction) => ({
        factionId: faction.id,
        food: faction.resources.food,
        stone: faction.resources.stone,
        wood: faction.resources.wood,
      })),
    tileDeposits: {
      resourceLayoutHash,
      amountByKind: depositAmounts,
      activeByKind: activeDepositCounts,
      depleted: depletedDepositCount,
    },
    structuresByType: countBy(state.structures.map((structure) => structure.type)),
    livingAgentsByRole: countBy(state.agents.map((agent) => agent.role)),
  };
}

export function buildSnapshot(state, counters = {}) {
  const births = counters.births ?? 0;
  const deaths = counters.deaths ?? 0;
  const stages = countBy(state.agents.map(stageOf));
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    tick: state.tick,
    population: {
      living: state.agents.length,
      infant: stages.infant ?? 0,
      juvenile: stages.juvenile ?? 0,
      adult: stages.adult ?? 0,
      elder: stages.elder ?? 0,
      birthsCumulative: births,
      deathsCumulative: deaths,
      extinct: state.agents.length === 0,
    },
    traits: traitMetrics(state.agents),
    environment: environmentMetrics(state),
  };
}

function lineageRecord(agent, tick, records, founder) {
  if (!founder && (!agent.parents || agent.birthTick !== tick)) {
    throw new Error("unexpected entrant into isolated world");
  }
  if (agent.heritableTraits !== undefined) {
    for (const key of ["vitality", "carryingCapacity"]) {
      const value = agent.heritableTraits[key];
      if (!Number.isFinite(value) || value < POPULATION_TRAIT_MIN || value > POPULATION_TRAIT_MAX) {
        throw new Error(`out-of-bounds inherited trait: ${key}`);
      }
    }
  }
  const parents = agent.parents ?? [];
  if (!founder && parents.some((id) => !records.has(id))) throw new Error("unobserved parent");
  const ancestry = new Map();
  if (founder) ancestry.set(agent.id, 1);
  else for (const id of parents) {
    for (const [ancestor, weight] of records.get(id).ancestry) {
      ancestry.set(ancestor, (ancestry.get(ancestor) ?? 0) + weight / parents.length);
    }
  }
  return {
    id: agent.id, founder, parents: [...parents], birthTick: agent.birthTick ?? null,
    firstSeenTick: tick, deathTick: null, traits: normalizedHeritableTraits(agent),
    generation: founder ? 0 : Math.max(...parents.map((id) => records.get(id).generation)) + 1,
    ancestry, children: 0,
  };
}

export function initializeLineage(state) {
  const records = new Map();
  for (const agent of state.agents) records.set(agent.id, lineageRecord(agent, state.tick, records, true));
  return {
    records, previousLiving: new Set(records.keys()), births: 0, deaths: 0,
    extinctionTick: state.agents.length === 0 ? state.tick : null,
  };
}

export function observeLineage(tracker, state) {
  const currentLiving = new Set(state.agents.map((agent) => agent.id));
  if (currentLiving.size !== state.agents.length) throw new Error("duplicate agent identity");
  for (const agent of state.agents) {
    if (tracker.previousLiving.has(agent.id)) continue;
    if (tracker.records.has(agent.id)) throw new Error("dead agent identity reused");
    const record = lineageRecord(agent, state.tick, tracker.records, false);
    tracker.records.set(agent.id, record);
    tracker.births += 1;
    for (const id of new Set(record.parents)) tracker.records.get(id).children += 1;
  }
  for (const id of tracker.previousLiving) {
    if (currentLiving.has(id)) continue;
    tracker.deaths += 1;
    tracker.records.get(id).deathTick = state.tick;
  }
  if (tracker.extinctionTick === null && currentLiving.size === 0) tracker.extinctionTick = state.tick;
  tracker.previousLiving = currentLiving;
}

export function lineageSummary(tracker) {
  const records = [...tracker.records.values()];
  const alive = (record) => tracker.previousLiving.has(record.id);
  const knownDead = records.filter((record) => record.deathTick !== null && record.birthTick !== null);
  const founders = records.filter((record) => record.founder).map((record) => {
    const descendants = records.filter((entry) => entry.id !== record.id && entry.ancestry.has(record.id));
    const contribution = records.filter(alive).reduce((sum, entry) => sum + (entry.ancestry.get(record.id) ?? 0), 0);
    return {
      agentId: record.id, descendants: descendants.length,
      livingDescendants: descendants.filter(alive).length,
      livingAncestryShare: tracker.previousLiving.size === 0 ? null : rounded(contribution / tracker.previousLiving.size),
    };
  }).sort((a, b) => (b.livingAncestryShare ?? 0) - (a.livingAncestryShare ?? 0)
    || (a.agentId < b.agentId ? -1 : 1));
  const generations = [...new Set(records.map((entry) => entry.generation))].sort((a, b) => a - b);
  return {
    observedAgents: records.length, founders: founders.length,
    lineageBorn: records.length - founders.length,
    births: tracker.births, deaths: tracker.deaths, extinctionTick: tracker.extinctionTick,
    maxGeneration: Math.max(0, ...generations),
    completedLifespan: distribution(knownDead.map((record) => record.deathTick - record.birthTick)),
    unknownBirthDateDeaths: records.filter((record) => record.deathTick !== null && record.birthTick === null).length,
    rightCensoredKnownLifetimes: records.filter((record) => alive(record) && record.birthTick !== null).length,
    topFounderConcentration: founders[0]?.livingAncestryShare ?? null,
    topFounders: founders.slice(0, 8),
    generations: generations.map((generation) => {
      const cohort = records.filter((record) => record.generation === generation);
      return {
        generation, observed: cohort.length, living: cohort.filter(alive).length,
        deaths: cohort.filter((record) => !alive(record)).length,
        children: distribution(cohort.map((record) => record.children)),
        vitalityAtBirth: distribution(cohort.map((record) => record.traits.vitality)),
        carryingCapacityAtBirth: distribution(cohort.map((record) => record.traits.carryingCapacity)),
      };
    }),
  };
}

function traitDelta(initial, final) {
  const delta = (a, b) => a === null || b === null ? null : rounded(b - a);
  return {
    vitalityMean: delta(initial.vitality.mean, final.vitality.mean),
    vitalityVariance: delta(initial.vitality.variance, final.vitality.variance),
    carryingCapacityMean: delta(initial.carryingCapacity.mean, final.carryingCapacity.mean),
    carryingCapacityVariance: delta(initial.carryingCapacity.variance, final.carryingCapacity.variance),
  };
}

export async function runEvolutionCanary(options = {}) {
  const seed = finiteInteger(options.seed ?? DEFAULT_SEED, "seed", { max: 0xffff_ffff });
  const ticks = finiteInteger(options.ticks ?? DEFAULT_TICKS, "ticks", { min: 1 });
  const sampleEvery = finiteInteger(options.sampleEvery ?? DEFAULT_SAMPLE_EVERY, "sampleEvery", { min: 1 });
  const maxRuntimeMs = options.maxRuntimeMs === undefined ? null
    : finiteInteger(options.maxRuntimeMs, "maxRuntimeMs", { min: 1 });
  const commit = options.commit ?? null;
  if (commit !== null && typeof commit !== "string") throw new Error("invalid commit");
  if (options.onSnapshot !== undefined && typeof options.onSnapshot !== "function") throw new Error("invalid snapshot observer");
  return withProductionIoGuard(() => {
    const startedAt = performance.now();
    const runtime = new WorldRuntime({
      state: createInitialWorld({ seed, worldId: "evolution-canary", regionId: "evolution-canary" }),
      simulationConfig: { ...DEFAULT_SIMULATION_CONFIG },
    });
    let state = runtime.snapshot();
    const tracker = initializeLineage(state);
    const initial = buildSnapshot(state, tracker);
    const snapshots = [];
    const series = createHash("sha256");
    let snapshotCount = 0;
    let lastSampleTick = -1;
    function sample(snapshot) {
      const line = stableStringify(snapshot) + "\n";
      series.update(line);
      snapshotCount += 1;
      lastSampleTick = snapshot.tick;
      if (options.collectSnapshots !== false) snapshots.push(snapshot);
      options.onSnapshot?.(structuredClone(snapshot), line);
    }
    sample(initial);
    let stopReason = null;
    while (state.tick < ticks) {
      if (maxRuntimeMs !== null && performance.now() - startedAt >= maxRuntimeMs) {
        stopReason = "max-runtime-ms";
        break;
      }
      state = runtime.tick().state;
      observeLineage(tracker, state); // Every tick, not the truncated event log or sample interval.
      if (state.tick % sampleEvery === 0) sample(buildSnapshot(state, tracker));
    }
    const final = buildSnapshot(state, tracker);
    if (lastSampleTick !== state.tick) sample(final);
    const deterministicPayload = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      run: {
        commit, seed, requestedTicks: ticks, completedTicks: state.tick, sampleEvery,
        simulationConfig: { ...DEFAULT_SIMULATION_CONFIG },
        world: { width: state.width, height: state.height, regionId: state.regionId },
        completed: state.tick === ticks, stopReason,
        populationDayTicks: POPULATION_DAY_TICKS,
        elderAgeTicks: POPULATION_ELDER_AGE_TICKS,
        neutralLifespanTicks: { min: POPULATION_MIN_LIFESPAN_TICKS, max: POPULATION_MAX_LIFESPAN_TICKS },
        engineHash: engine.hash,
      },
      snapshotCount, snapshotSeriesHash: series.digest("hex"),
      finalStateHash: sha256(state),
      initialPopulation: initial.population.living, finalPopulation: final.population.living,
      lineage: lineageSummary(tracker),
      initialTraits: initial.traits, finalTraits: final.traits,
      traitDelta: traitDelta(initial.traits, final.traits),
      finalEnvironment: final.environment,
    };
    return { snapshots, summary: {
      ...deterministicPayload,
      deterministicResultHash: sha256(deterministicPayload),
      durationMs: rounded(performance.now() - startedAt, 3),
      runtimeLimitMs: maxRuntimeMs,
    } };
  });
}

function detectCommit() {
  if (typeof process.env.GITHUB_SHA === "string" && process.env.GITHUB_SHA.length > 0) {
    return process.env.GITHUB_SHA;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

export function localOutputDirectory(value, seed, ticks) {
  const candidate = value ?? `artifacts/evolution-canary/seed-${seed}-ticks-${ticks}`;
  if (!candidate || /^[a-z][a-z0-9+.-]*:/i.test(candidate) || candidate.startsWith("//") || candidate.includes("\\")) {
    throw new Error("--output must be a new local directory, not a URL or network path");
  }
  const output = resolve(candidate);
  // Never follow symlinks into storage, and never overwrite an existing run.
  let ancestor = output;
  while (true) {
    try {
      const entry = lstatSync(ancestor);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("unsafe output ancestor");
      if (ancestor === output) throw new Error("output directory already exists");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const part of output.split(sep)) {
    if ([".wrangler", ".git", "node_modules", "dist-ts", "src"].includes(part)) throw new Error("reserved output path");
  }
  return output;
}

function cliOptions() {
  const { values } = parseArgs({
    options: {
      seed: { type: "string" },
      ticks: { type: "string" },
      "sample-every": { type: "string" },
      output: { type: "string" },
      "max-runtime-ms": { type: "string" },
      commit: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const seed = finiteInteger(values.seed ?? DEFAULT_SEED, "seed", { max: 0xffff_ffff });
  const ticks = finiteInteger(values.ticks ?? DEFAULT_TICKS, "ticks", { min: 1 });
  const sampleEvery = finiteInteger(values["sample-every"] ?? DEFAULT_SAMPLE_EVERY, "sampleEvery", { min: 1 });
  const maxRuntimeMs = values["max-runtime-ms"] === undefined
    ? undefined
    : finiteInteger(values["max-runtime-ms"], "maxRuntimeMs", { min: 1 });
  return {
    seed,
    ticks,
    sampleEvery,
    maxRuntimeMs,
    commit: values.commit ?? detectCommit(),
    outputDirectory: localOutputDirectory(values.output, seed, ticks),
  };
}

async function main() {
  const options = cliOptions();
  mkdirSync(dirname(options.outputDirectory), { recursive: true });
  mkdirSync(options.outputDirectory);
  const snapshotsPath = resolve(options.outputDirectory, "snapshots.jsonl");
  const summaryPath = resolve(options.outputDirectory, "summary.json");
  const fd = openSync(snapshotsPath, "wx");
  let result;
  try {
    result = await runEvolutionCanary({ ...options, collectSnapshots: false,
      onSnapshot: (_snapshot, line) => { writeSync(fd, line); },
    });
  } finally { closeSync(fd); }
  writeFileSync(summaryPath, JSON.stringify(result.summary, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({
    seed: result.summary.run.seed, requestedTicks: options.ticks,
    completedTicks: result.summary.run.completedTicks, completed: result.summary.run.completed,
    finalPopulation: result.summary.finalPopulation, births: result.summary.lineage.births,
    deaths: result.summary.lineage.deaths, maxGeneration: result.summary.lineage.maxGeneration,
    durationMs: result.summary.durationMs, deterministicResultHash: result.summary.deterministicResultHash,
    snapshots: snapshotsPath, summary: summaryPath,
  }) + "\n");
  if (!result.summary.run.completed) process.exitCode = 2;
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
