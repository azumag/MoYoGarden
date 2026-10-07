#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normalizedHeritableTraits } from "../dist-ts/src/demography.js";
import { DEFAULT_SIMULATION_CONFIG } from "../dist-ts/src/protocol.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const ARTIFACT_SCHEMA_VERSION = 1;
const DEFAULT_SEED = 3902;
const DEFAULT_TICKS = 100_000;
const DEFAULT_SAMPLE_EVERY = 8_640;
const BLOCKED_GLOBALS = ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"];

function finiteInteger(value, name, { min = 0 } = {}) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return parsed;
}

function rounded(value, digits = 8) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
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
    return { count: 0, mean: 0, min: 0, max: 0, variance: 0, p10: 0, p50: 0, p90: 0 };
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
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
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

function initializeLineage(state) {
  const records = new Map();
  for (const agent of state.agents) {
    records.set(agent.id, {
      id: agent.id,
      founder: true,
      parents: agent.parents === undefined ? [] : [...agent.parents],
      birthTick: agent.birthTick ?? state.tick,
      deathTick: null,
    });
  }
  return {
    records,
    previousLiving: new Set(state.agents.map((agent) => agent.id)),
    births: 0,
    deaths: 0,
    extinctionTick: state.agents.length === 0 ? state.tick : null,
  };
}

function observeLineage(tracker, state) {
  const currentLiving = new Set(state.agents.map((agent) => agent.id));
  for (const agent of state.agents) {
    if (tracker.previousLiving.has(agent.id)) continue;
    tracker.births += 1;
    tracker.records.set(agent.id, {
      id: agent.id,
      founder: false,
      parents: agent.parents === undefined ? [] : [...agent.parents],
      birthTick: agent.birthTick ?? state.tick,
      deathTick: null,
    });
  }
  for (const agentId of tracker.previousLiving) {
    if (currentLiving.has(agentId)) continue;
    tracker.deaths += 1;
    const record = tracker.records.get(agentId);
    if (record !== undefined && record.deathTick === null) record.deathTick = state.tick;
  }
  if (tracker.extinctionTick === null && currentLiving.size === 0) tracker.extinctionTick = state.tick;
  tracker.previousLiving = currentLiving;
}

function descendantsFor(rootId, childrenByParent, cache, visiting = new Set()) {
  const cached = cache.get(rootId);
  if (cached !== undefined) return cached;
  if (visiting.has(rootId)) return new Set();
  const nextVisiting = new Set(visiting);
  nextVisiting.add(rootId);
  const descendants = new Set();
  for (const childId of childrenByParent.get(rootId) ?? []) {
    descendants.add(childId);
    for (const nestedId of descendantsFor(childId, childrenByParent, cache, nextVisiting)) {
      descendants.add(nestedId);
    }
  }
  cache.set(rootId, descendants);
  return descendants;
}

function lineageSummary(tracker, finalTick) {
  const childrenByParent = new Map();
  for (const record of tracker.records.values()) {
    for (const parentId of record.parents) {
      const children = childrenByParent.get(parentId) ?? [];
      children.push(record.id);
      childrenByParent.set(parentId, children);
    }
  }
  for (const children of childrenByParent.values()) children.sort((left, right) => left.localeCompare(right));

  const cache = new Map();
  const founders = [...tracker.records.values()]
    .filter((record) => record.founder)
    .map((record) => {
      const descendants = descendantsFor(record.id, childrenByParent, cache);
      return {
        agentId: record.id,
        descendants: descendants.size,
        livingDescendants: [...descendants].filter((agentId) => tracker.previousLiving.has(agentId)).length,
      };
    })
    .sort((left, right) => right.descendants - left.descendants || left.agentId.localeCompare(right.agentId));
  const lineageBorn = [...tracker.records.values()].filter((record) => !record.founder).length;
  const lifespans = [...tracker.records.values()]
    .filter((record) => record.deathTick !== null)
    .map((record) => (record.deathTick ?? finalTick) - record.birthTick);

  return {
    observedAgents: tracker.records.size,
    founders: tracker.records.size - lineageBorn,
    lineageBorn,
    births: tracker.births,
    deaths: tracker.deaths,
    extinctionTick: tracker.extinctionTick,
    completedLifespan: distribution(lifespans),
    topFounderConcentration: lineageBorn === 0 ? 0 : rounded((founders[0]?.descendants ?? 0) / lineageBorn),
    topFounders: founders.slice(0, 8),
  };
}

function traitDelta(initial, final) {
  return {
    vitalityMean: rounded(final.vitality.mean - initial.vitality.mean),
    vitalityVariance: rounded(final.vitality.variance - initial.vitality.variance),
    carryingCapacityMean: rounded(final.carryingCapacity.mean - initial.carryingCapacity.mean),
    carryingCapacityVariance: rounded(final.carryingCapacity.variance - initial.carryingCapacity.variance),
  };
}

function patchBlockedGlobal(name, restore) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor !== undefined && descriptor.configurable === false) return;
  restore.push({ name, descriptor });
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: function blockedProductionIo() {
      throw new Error(`evolution canary blocked external I/O via ${name}`);
    },
  });
}

export async function withProductionIoGuard(callback) {
  const restore = [];
  for (const name of BLOCKED_GLOBALS) patchBlockedGlobal(name, restore);
  try {
    return await callback();
  } finally {
    for (const { name, descriptor } of restore.reverse()) {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }
}

export async function runEvolutionCanary(options = {}) {
  const seed = finiteInteger(options.seed ?? DEFAULT_SEED, "seed");
  const ticks = finiteInteger(options.ticks ?? DEFAULT_TICKS, "ticks", { min: 1 });
  const sampleEvery = finiteInteger(options.sampleEvery ?? DEFAULT_SAMPLE_EVERY, "sampleEvery", { min: 1 });
  const maxRuntimeMs = options.maxRuntimeMs === undefined
    ? undefined
    : finiteInteger(options.maxRuntimeMs, "maxRuntimeMs", { min: 1 });
  const commit = typeof options.commit === "string" && options.commit.length > 0 ? options.commit : null;

  return withProductionIoGuard(async () => {
    const initialState = createInitialWorld({
      seed,
      worldId: "evolution-canary",
      regionId: "evolution-canary",
    });
    const runtime = new WorldRuntime({
      state: initialState,
      simulationConfig: DEFAULT_SIMULATION_CONFIG,
    });
    let state = runtime.snapshot();
    const tracker = initializeLineage(state);
    const snapshots = [buildSnapshot(state, tracker)];
    const initialTraits = snapshots[0].traits;
    const startedAt = performance.now();
    let stopReason = null;

    while (state.tick < ticks) {
      if (maxRuntimeMs !== undefined && performance.now() - startedAt >= maxRuntimeMs) {
        stopReason = "max-runtime-ms";
        break;
      }
      state = runtime.tick().state;
      observeLineage(tracker, state);
      if (state.tick % sampleEvery === 0) snapshots.push(buildSnapshot(state, tracker));
    }

    if (snapshots.at(-1)?.tick !== state.tick) snapshots.push(buildSnapshot(state, tracker));

    const finalTraits = traitMetrics(state.agents);
    const lineage = lineageSummary(tracker, state.tick);
    const deterministicPayload = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      run: {
        commit,
        seed,
        requestedTicks: ticks,
        completedTicks: state.tick,
        sampleEvery,
        simulationConfig: { ...DEFAULT_SIMULATION_CONFIG },
        world: { width: state.width, height: state.height, regionId: state.regionId },
        completed: state.tick >= ticks,
        stopReason,
      },
      snapshotCount: snapshots.length,
      snapshotSeriesHash: sha256(snapshots),
      lineage,
      initialTraits,
      finalTraits,
      traitDelta: traitDelta(initialTraits, finalTraits),
      finalEnvironment: environmentMetrics(state),
    };
    const deterministicResultHash = sha256(deterministicPayload);
    const durationMs = rounded(performance.now() - startedAt, 3);
    const summary = {
      ...deterministicPayload,
      durationMs,
      deterministicResultHash,
    };

    return { snapshots, summary };
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

function localOutputDirectory(value, seed, ticks) {
  const candidate = value ?? `artifacts/evolution-canary/seed-${seed}-ticks-${ticks}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    throw new Error("--output must be a local filesystem path, not a URL");
  }
  return resolve(candidate);
}

async function writeArtifacts(outputDirectory, result) {
  await mkdir(outputDirectory, { recursive: true });
  const snapshotsPath = resolve(outputDirectory, "snapshots.jsonl");
  const summaryPath = resolve(outputDirectory, "summary.json");
  const snapshotText = `${result.snapshots.map((snapshot) => JSON.stringify(snapshot)).join("\n")}\n`;
  await writeFile(snapshotsPath, snapshotText, "utf8");
  await writeFile(summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8");
  return { snapshotsPath, summaryPath };
}

function cliOptions() {
  const { values } = parseArgs({
    options: {
      seed: { type: "string" },
      ticks: { type: "string" },
      "sample-every": { type: "string" },
      output: { type: "string" },
      "max-runtime-ms": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const seed = finiteInteger(values.seed ?? DEFAULT_SEED, "seed");
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
    outputDirectory: localOutputDirectory(values.output, seed, ticks),
  };
}

async function main() {
  const options = cliOptions();
  const result = await runEvolutionCanary({ ...options, commit: detectCommit() });
  const files = await writeArtifacts(options.outputDirectory, result);
  const finalSnapshot = result.snapshots.at(-1);
  process.stdout.write(`${JSON.stringify({
    seed: result.summary.run.seed,
    requestedTicks: result.summary.run.requestedTicks,
    completedTicks: result.summary.run.completedTicks,
    finalPopulation: finalSnapshot?.population.living ?? 0,
    births: result.summary.lineage.births,
    deaths: result.summary.lineage.deaths,
    durationMs: result.summary.durationMs,
    deterministicResultHash: result.summary.deterministicResultHash,
    snapshots: files.snapshotsPath,
    summary: files.summaryPath,
  })}\n`);
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
