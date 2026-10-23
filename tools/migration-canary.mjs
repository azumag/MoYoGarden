#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { auditMigrationEngine, withProductionIoGuard } from "./evolution-isolation.mjs";
import { buildSnapshot, initializeLineage, observeLineage, lineageSummary,
  localOutputDirectory, stableStringify } from "./evolution-canary.mjs";
import { integer, migrationSchedule, migrationSlotsAt, compareMigrationRuns, MIGRATION_MODES } from "./migration-schedule.mjs";

const engine = auditMigrationEngine();
const [world, ownership, topology, grid, protocol, { WorldRuntime }, demography] = await withProductionIoGuard(() => Promise.all([
  import("../dist-ts/src/world.js"), import("../dist-ts/src/agent-ownership.js"),
  import("../dist-ts/src/region-topology.js"), import("../dist-ts/src/hex-grid.js"),
  import("../dist-ts/src/protocol.js"), import("../dist-ts/src/runtime.js"), import("../dist-ts/src/demography.js"),
]));
const hash = (value) => createHash("sha256").update(stableStringify(value)).digest("hex");
const implementationHash = hash(["migration-canary", "migration-schedule", "evolution-canary", "evolution-isolation"]
  .map((name) => readFileSync(new URL(`./${name}.mjs`, import.meta.url), "utf8")));
const canonicalId = (agent, state) => ownership.globalHandoffAgentId(agent.id, state.regionId);
const cellKey = (p) => `${p.x},${p.y}`;
const sameCell = (a, b) => a.x === b.x && a.y === b.y;
const runtimeFor = (state, pendingCommands = []) => new WorldRuntime({ state, pendingCommands,
  simulationConfig: { ...protocol.DEFAULT_SIMULATION_CONFIG } });

// Canonicalize ONLY observation copies, not engine IDs/reproductive-role hashes.
export function populationView(states) {
  if (states.some((s) => s.tick !== states[0].tick)) throw new Error("unsynchronized region ticks");
  const agents = states.flatMap((state) => state.agents.map((agent) => ({ ...agent,
    id: canonicalId(agent, state),
    ...(agent.parents === undefined ? {} : {
      parents: agent.parents.map((id) => ownership.globalHandoffAgentId(id, state.regionId)),
    }),
  })));
  if (new Set(agents.map((a) => a.id)).size !== agents.length) throw new Error("duplicate global ownership");
  return { tick: states[0].tick, agents };
}

// Multi-source BFS: only existing passable cells and exact global-cell seams.
function exitRoutes(source, target) {
  const routes = new Map();
  const queue = [];
  for (const tile of [...source.tiles].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (!world.isPassable(source, tile)) continue;
    for (const step of grid.HEX_GRID_STEPS) {
      const crossing = topology.regionCellTransition(source.regionId,
        { x: tile.x + step.x, y: tile.y + step.y }, source.width, source.height);
      if (crossing?.targetRegionId !== target.regionId || !world.isPassable(target, crossing.targetPosition)) continue;
      const key = cellKey(tile);
      if (!routes.has(key)) {
        routes.set(key, { sourcePosition: { x: tile.x, y: tile.y }, targetPosition: crossing.targetPosition, distance: 0 });
        queue.push({ x: tile.x, y: tile.y });
      }
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const position = queue[cursor];
    const route = routes.get(cellKey(position));
    for (const step of grid.HEX_GRID_STEPS) {
      const neighbor = { x: position.x + step.x, y: position.y + step.y };
      if (routes.has(cellKey(neighbor)) || !world.isPassable(source, neighbor)) continue;
      routes.set(cellKey(neighbor), { ...route, distance: route.distance + 1 });
      queue.push(neighbor);
    }
  }
  return routes;
}

function chooseTraveller(states, direction, ticket, seed, maxTravelTicks) {
  const source = states[direction], target = states[1 - direction];
  const routes = exitRoutes(source, target);
  const caregivers = new Set(source.agents.filter((a) => a.lifeStage === "infant" || a.lifeStage === "juvenile")
    .map((a) => demography.dependentCaregiverId(source, a)));
  return source.agents.filter((a) => a.autonomy && a.hp > 0 && !a.pregnancy && !caregivers.has(a.id)
    && (a.lifeStage === undefined || a.lifeStage === "adult") && a.task?.source !== "external"
    && routes.has(cellKey(a.position)) && routes.get(cellKey(a.position)).distance < maxTravelTicks)
    .map((a) => ({ agentId: a.id, globalId: canonicalId(a, source), ...routes.get(cellKey(a.position)),
      rank: hash([seed, ticket, direction, canonicalId(a, source)]) }))
    .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)[0];
}

// Pure, all-or-nothing local transfer using the same ownership helpers as the game.
// This is NOT the distributed crash/retry journal or a production transport.
export function transferAtSeam(states, direction, plan) {
  const source = states[direction], target = states[1 - direction];
  populationView(states);
  const agent = source.agents.find((a) => a.id === plan.agentId);
  if (!agent || !sameCell(agent.position, plan.sourcePosition)) return { ok: false, reason: "not-at-seam" };
  if (!world.isPassable(source, agent.position)) return { ok: false, reason: "blocked-source" };
  const exact = grid.HEX_GRID_STEPS.some((step) => {
    const transition = topology.regionCellTransition(source.regionId,
      { x: agent.position.x + step.x, y: agent.position.y + step.y }, source.width, source.height);
    return transition?.targetRegionId === target.regionId && sameCell(transition.targetPosition, plan.targetPosition);
  });
  if (!exact) return { ok: false, reason: "not-an-exact-seam" };
  const detached = ownership.detachAgentOwnership(source, [], agent.id);
  if (!detached.ok) return { ok: false, reason: detached.reason };
  const attached = ownership.attachAgentOwnership(target, [], detached.value.agent, plan.targetPosition, source.regionId);
  if (!attached.ok) return { ok: false, reason: attached.reason };
  const next = [...states];
  next[direction] = detached.value.snapshot.state;
  next[1 - direction] = attached.value.state;
  const before = populationView(states).agents.map((a) => a.id).sort();
  const after = populationView(next).agents.map((a) => a.id).sort();
  if (stableStringify(before) !== stableStringify(after)) throw new Error("migration changed global population");
  return { ok: true, states: next };
}

function configFor(options) {
  const schedule = migrationSchedule(options);
  const seed = integer(options.seed ?? 3902, "seed", 0, 0xffff_ffff);
  const ticks = integer(options.ticks ?? schedule.period, "ticks", 1, 10_000_000);
  if (ticks % schedule.period) throw new Error("ticks must contain whole migration periods");
  const maxTravelTicks = integer(options.maxTravelTicks ?? 64, "maxTravelTicks", 1, 1024);
  const sampleEvery = integer(options.sampleEvery ?? schedule.period, "sampleEvery");
  const maxRuntimeMs = options.maxRuntimeMs === undefined ? null : integer(options.maxRuntimeMs, "maxRuntimeMs");
  if (options.commit != null && typeof options.commit !== "string") throw new Error("invalid commit");
  for (const name of ["onSnapshot", "onEvent"]) {
    if (options[name] !== undefined && typeof options[name] !== "function") throw new Error(`invalid ${name}`);
  }
  return { seed, schedule, ticks, maxTravelTicks, sampleEvery, maxRuntimeMs, commit: options.commit ?? null };
}

export async function runMigrationCanary(options = {}) {
  const config = configFor(options);
  const { seed, schedule, ticks, maxTravelTicks, sampleEvery, maxRuntimeMs, commit } = config;
  return withProductionIoGuard(() => {
    const start = performance.now();
    // Two local generated habitats, identical across arms; NOT a production frontier replay.
    const habitatSeeds = [seed, Number.parseInt(hash([seed, "habitat-b"]).slice(0, 8), 16)];
    let states = ["garden-1", "garden-2"].map((regionId, i) => world.createInitialWorld({
      seed: habitatSeeds[i], width: 40, height: 24, worldId: "migration-canary", regionId,
    }));
    let runtimes = states.map((s) => runtimeFor(s));
    const initialStateHash = hash(states);
    const tracker = initializeLineage(populationView(states));
    const counters = states.map(() => ({ births: 0, deaths: 0, arrivals: 0, departures: 0 }));
    const initialPopulation = states.map((s) => s.agents.length);
    const migration = states.map((s, i) => ({ from: s.regionId, to: states[1 - i].regionId,
      scheduled: 0, started: 0, arrived: 0, skipped: 0, failed: 0, inFlight: 0 }));
    const plans = [null, null];
    const snapshots = [], events = [];
    const snapshotHasher = createHash("sha256"), eventHasher = createHash("sha256");
    let snapshotCount = 0, eventCount = 0, lastSample = -1, lastSnapshot;
    function emit(event) {
      const line = stableStringify(event) + "\n";
      eventHasher.update(line); eventCount += 1;
      if (options.collectEvents !== false) events.push(event);
      options.onEvent?.(structuredClone(event), line);
    }
    function sample() {
      for (let i = 0; i < 2; i += 1) {
        const c = counters[i];
        if (initialPopulation[i] + c.births - c.deaths + c.arrivals - c.departures !== states[i].agents.length) {
          throw new Error("regional population balance failed");
        }
        migration[i].inFlight = plans[i] === null ? 0 : 1;
      }
      const view = populationView(states);
      const global = buildSnapshot({ ...states[0], agents: view.agents }, tracker);
      const snapshot = { schemaVersion: 1, tick: view.tick,
        population: global.population, traits: global.traits,
        regions: states.map((s, i) => ({ regionId: s.regionId, ...buildSnapshot(s, counters[i]), ...counters[i] })),
        migration: structuredClone(migration) };
      const line = stableStringify(snapshot) + "\n";
      snapshotHasher.update(line); snapshotCount += 1; lastSample = view.tick;
      if (options.collectSnapshots !== false) snapshots.push(snapshot);
      options.onSnapshot?.(structuredClone(snapshot), line);
      lastSnapshot = snapshot;
      return snapshot;
    }
    const initial = sample();
    let stopReason = null;
    // Fixed, identical drain interval; late journeys must settle, not disappear from counts.
    const requestedWorldTicks = ticks + maxTravelTicks + 1;
    while (states[0].tick < requestedWorldTicks) {
      if (maxRuntimeMs !== null && performance.now() - start >= maxRuntimeMs) { stopReason = "max-runtime-ms"; break; }
      const tick = states[0].tick + 1;
      const slots = tick <= ticks ? migrationSlotsAt(schedule, tick) : [0, 0];
      for (let i = 0; i < 2; i += 1) {
        if (slots[i] === 0) continue;
        const m = migration[i]; m.scheduled += 1;
        const selected = plans[i] ? null : chooseTraveller(states, i, m.scheduled, seed, maxTravelTicks);
        if (!selected) {
          m.skipped += 1;
          emit({ tick, direction: i, status: "skipped", reason: plans[i] ? "in-flight" : "no-eligible-reachable-adult" });
          continue;
        }
        const plan = { ...selected, scheduledTick: tick };
        plans[i] = plan; m.started += 1;
        const id = `migration-${i}-${tick}`;
        // submit() creates external entropy; the existing deterministic queue/parse boundary does not.
        const command = protocol.parseCommand(plan.agentId,
          { id, type: "move", target: plan.sourcePosition }, states[i].tick, id);
        runtimes[i] = runtimeFor(states[i], [...runtimes[i].pendingCommands(), command]);
        emit({ tick, direction: i, status: "started", agentId: plan.globalId,
          sourcePosition: plan.sourcePosition, targetPosition: plan.targetPosition });
      }
      const before = states.map((s) => new Set(s.agents.map((a) => canonicalId(a, s))));
      const previousGlobal = new Set(before.flatMap((ids) => [...ids]));
      states = runtimes.map((r) => r.tick().state);
      const view = populationView(states);
      const currentGlobal = new Set(view.agents.map((a) => a.id));
      observeLineage(tracker, view);
      for (let i = 0; i < 2; i += 1) {
        counters[i].births += states[i].agents.filter((a) => !previousGlobal.has(canonicalId(a, states[i]))).length;
        counters[i].deaths += [...before[i]].filter((id) => !currentGlobal.has(id)).length;
      }
      const cleanup = [[], []];
      let transferred = false;
      for (let i = 0; i < 2; i += 1) {
        const plan = plans[i];
        if (!plan) continue;
        const agent = states[i].agents.find((a) => a.id === plan.agentId);
        let reason = agent ? null : "traveller-died";
        if (agent && sameCell(agent.position, plan.sourcePosition)) {
          const result = transferAtSeam(states, i, plan);
          if (result.ok) {
            states = result.states; transferred = true;
            migration[i].arrived += 1; counters[i].departures += 1; counters[1 - i].arrivals += 1;
            emit({ tick, direction: i, status: "arrived", agentId: plan.globalId, scheduledTick: plan.scheduledTick,
              travelTicks: tick - plan.scheduledTick + 1 });
            plans[i] = null;
            continue;
          }
          reason = result.reason;
        } else if (agent && tick - plan.scheduledTick + 1 >= maxTravelTicks) reason = "travel-timeout";
        if (reason !== null) {
          migration[i].failed += 1; plans[i] = null;
          if (agent) {
            const id = `migration-clear-${i}-${tick}`;
            cleanup[i].push(protocol.parseCommand(agent.id, { id, type: "clear_task" }, tick, id));
          }
          emit({ tick, direction: i, status: "failed", agentId: plan.globalId, reason, scheduledTick: plan.scheduledTick });
        }
      }
      // Migration must not look like a birth/death, including local -> global ID promotion.
      observeLineage(tracker, populationView(states));
      for (let i = 0; i < 2; i += 1) {
        if (transferred || cleanup[i].length) runtimes[i] = runtimeFor(states[i], cleanup[i]);
      }
      if (tick % sampleEvery === 0) sample();
    }
    if (lastSample !== states[0].tick) sample();
    const finalMetrics = lastSnapshot;
    const payload = { schemaVersion: 1,
      run: { seed, habitatSeeds, schedule, scheduleTicks: ticks, requestedWorldTicks,
        completedTicks: states[0].tick, completed: states[0].tick === requestedWorldTicks, stopReason,
        maxTravelTicks, sampleEvery, commit, engineHash: engine.hash, implementationHash,
        populationDayTicks: demography.POPULATION_DAY_TICKS,
        simulationConfig: { ...protocol.DEFAULT_SIMULATION_CONFIG } },
      initialStateHash, finalStateHash: hash({ states, plans, pendingCommands: runtimes.map((r) => r.pendingCommands()) }),
      snapshotCount, snapshotSeriesHash: snapshotHasher.digest("hex"), eventCount, eventSeriesHash: eventHasher.digest("hex"),
      initialPopulation, finalPopulation: states.map((s) => s.agents.length),
      initialTraits: initial.traits, finalTraits: finalMetrics.traits,
      migration, regions: counters, finalRegions: finalMetrics.regions, lineage: lineageSummary(tracker) };
    return { snapshots, events, summary: { ...payload, deterministicResultHash: hash(payload),
      durationMs: Math.round((performance.now() - start) * 1000) / 1000, runtimeLimitMs: maxRuntimeMs } };
  });
}

async function main() {
  const { values } = parseArgs({ options: Object.fromEntries([
    "seed", "ticks", "period", "migrants", "max-travel-ticks", "sample-every", "max-runtime-ms", "output", "mode", "commit",
  ].map((name) => [name, { type: "string" }])), strict: true, allowPositionals: false });
  const modes = values.mode === "all" || values.mode === undefined ? MIGRATION_MODES : [values.mode];
  const options = { seed: values.seed, ticks: values.ticks, period: values.period, migrants: values.migrants,
    maxTravelTicks: values["max-travel-ticks"], sampleEvery: values["sample-every"], maxRuntimeMs: values["max-runtime-ms"],
    commit: values.commit ?? process.env.GITHUB_SHA ?? null };
  const config = configFor({ ...options, mode: modes[0] });
  const output = localOutputDirectory(values.output ?? `artifacts/migration-canary/seed-${config.seed}-ticks-${config.ticks}`,
    config.seed, config.ticks);
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(output);
  const summaries = [];
  for (const mode of modes) {
    const directory = resolve(output, mode); mkdirSync(directory);
    const snapshotFd = openSync(resolve(directory, "snapshots.jsonl"), "wx");
    const eventFd = openSync(resolve(directory, "migration.jsonl"), "wx");
    let result;
    try {
      result = await runMigrationCanary({ ...options, mode, collectSnapshots: false, collectEvents: false,
        onSnapshot: (_s, line) => writeSync(snapshotFd, line), onEvent: (_e, line) => writeSync(eventFd, line) });
    } finally { closeSync(snapshotFd); closeSync(eventFd); }
    writeFileSync(resolve(directory, "summary.json"), JSON.stringify(result.summary, null, 2) + "\n", { flag: "wx" });
    summaries.push(result.summary);
    if (!result.summary.run.completed) { process.exitCode = 2; break; }
  }
  const comparison = { schemaVersion: 1, comparisons: compareMigrationRuns(summaries),
    runs: summaries.map((s) => ({ mode: s.run.schedule.mode, hash: s.deterministicResultHash })) };
  writeFileSync(resolve(output, "comparison.json"), JSON.stringify(comparison, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ output, ...comparison }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}
