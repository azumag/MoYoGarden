import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MIGRATION_MODES, migrationSchedule, migrationSlotsAt, compareMigrationRuns } from "../tools/migration-schedule.mjs";
import { populationView, transferAtSeam, runMigrationCanary } from "../tools/migration-canary.mjs";
import { auditEvolutionEngine, auditMigrationEngine, withProductionIoGuard } from "../tools/evolution-isolation.mjs";
import { initializeLineage, observeLineage, stableStringify } from "../tools/evolution-canary.mjs";
import { createInitialWorld, isPassable } from "../dist-ts/src/world.js";
import { HEX_GRID_STEPS } from "../dist-ts/src/hex-grid.js";
import { regionCellTransition } from "../dist-ts/src/region-topology.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");

function worldsAtSeam() {
  const states = ["garden-1", "garden-2"].map((regionId, i) => createInitialWorld({
    seed: 3902 + i, width: 40, height: 24, worldId: "test-migration", regionId,
  }));
  const source = states[0], target = states[1];
  for (const tile of source.tiles) {
    if (!isPassable(source, tile)) continue;
    for (const step of HEX_GRID_STEPS) {
      const transition = regionCellTransition(source.regionId, { x: tile.x + step.x, y: tile.y + step.y }, source.width, source.height);
      if (transition?.targetRegionId !== target.regionId || !isPassable(target, transition.targetPosition)) continue;
      const mover = source.agents[0];
      mover.position = { x: tile.x, y: tile.y };
      mover.heritableTraits = { vitality: 1.05, carryingCapacity: 0.95 };
      mover.inventory = { food: 2, wood: 3, stone: 1 };
      return { states, plan: { agentId: mover.id, sourcePosition: mover.position, targetPosition: transition.targetPosition } };
    }
  }
  throw new Error("fixture has no reciprocal passable seam");
}

test("all schedules conserve directional budgets across periods, phases and asymmetry", () => {
  for (const period of [16, 64, 8640]) for (const mode of MIGRATION_MODES) {
    const schedule = migrationSchedule({ period, mode });
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const counts = [0, 0];
      for (let tick = 1; tick <= period; tick += 1) {
        migrationSlotsAt(schedule, cycle * period + tick).forEach((n, d) => {
          assert.ok(n === 0 || n === 1); counts[d] += n;
        });
      }
      assert.deepEqual(counts, schedule.quotas);
      assert.equal(counts[0] + counts[1], 4);
    }
  }
});

test("opposite phases really separate departure slots; synced phases do not", () => {
  const synced = migrationSchedule({ period: 64, mode: "in-phase" });
  const opposed = migrationSchedule({ period: 64, mode: "out-of-phase" });
  for (let tick = 1; tick <= 64; tick += 1) {
    const [a, b] = migrationSlotsAt(synced, tick);
    assert.equal(a, b);
    const [c, d] = migrationSlotsAt(opposed, tick);
    assert.ok(c === 0 || d === 0);
  }
});

test("invalid and unbounded parameters fail before simulation", async () => {
  for (const options of [{ period: 17 }, { period: 16, migrants: 8 }, { mode: "unknown" },
    { migrants: -4 }, { migrants: "4e0" }, { period: Infinity }]) {
    assert.throws(() => migrationSchedule(options));
  }
  for (const options of [{ ticks: 17, period: 16 }, { seed: -1 }, { maxTravelTicks: 2048 },
    { onSnapshot: true }, { onEvent: true }, { commit: 2 }, { maxRuntimeMs: NaN }]) {
    await assert.rejects(runMigrationCanary(options));
  }
});

test("observation IDs disambiguate local founders without changing engine state", () => {
  const { states } = worldsAtSeam();
  const before = structuredClone(states);
  assert.equal(states[0].agents[0].id, states[1].agents[0].id);
  const view = populationView(states);
  assert.equal(new Set(view.agents.map((a) => a.id)).size, 24);
  assert.deepEqual(states, before);
  states[1].tick += 1;
  assert.throws(() => populationView(states), /unsynchronized/);
});

test("exact-seam transfer conserves identities, cargo, traits, family and demographic counters", () => {
  const { states, plan } = worldsAtSeam();
  const mover = states[0].agents[0];
  const child = states[0].agents[1];
  child.parents = [mover.id, states[0].agents[2].id];
  const before = structuredClone(states);
  const tracker = initializeLineage(populationView(states));
  const result = transferAtSeam(states, 0, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(states, before);
  observeLineage(tracker, populationView(result.states));
  assert.equal(tracker.births, 0); assert.equal(tracker.deaths, 0);
  assert.deepEqual(result.states.map((s) => s.agents.length), [11, 13]);
  const id = `agent-global:garden-1:${mover.id}`;
  const arrived = result.states[1].agents.find((a) => a.id === id);
  assert.deepEqual(arrived.inventory, mover.inventory);
  assert.deepEqual(arrived.heritableTraits, mover.heritableTraits);
  assert.deepEqual(arrived.position, plan.targetPosition);
  assert.equal(result.states[0].agents.find((a) => a.id === child.id).parents[0], id);
  const repeat = transferAtSeam(result.states, 0, plan);
  assert.equal(repeat.ok, false);
});

test("blocked destination and non-seam jumps fail atomically", () => {
  const { states, plan } = worldsAtSeam();
  const target = states[1].tiles.find((t) => t.x === plan.targetPosition.x && t.y === plan.targetPosition.y);
  target.terrain = "water";
  const before = structuredClone(states);
  assert.equal(transferAtSeam(states, 0, plan).ok, false);
  assert.deepEqual(states, before);
  assert.equal(transferAtSeam(states, 0, { ...plan, targetPosition: { x: 19, y: 11 } }).ok, false);
  assert.deepEqual(states, before);
});

test("birth after migration remains linked to its original-region parent", () => {
  const { states, plan } = worldsAtSeam();
  const tracker = initializeLineage(populationView(states));
  const moved = transferAtSeam(states, 0, plan).states;
  const parent = moved[1].agents.find((a) => a.id.startsWith("agent-global:garden-1:"));
  const partner = moved[1].agents.find((a) => !a.id.startsWith("agent-global:"));
  const child = { ...structuredClone(parent), id: "agent-test-birth", birthTick: 1,
    parents: [parent.id, partner.id], lifeStage: "infant" };
  moved.forEach((s) => { s.tick = 1; }); moved[1].agents.push(child);
  observeLineage(tracker, populationView(moved));
  assert.equal(tracker.births, 1); assert.equal(tracker.deaths, 0);
  assert.equal(tracker.records.get("agent-global:garden-2:agent-test-birth").generation, 1);
  moved.forEach((s) => { s.tick = 2; });
  moved[1].agents = moved[1].agents.filter((a) => a.id !== parent.id);
  observeLineage(tracker, populationView(moved));
  assert.equal(tracker.deaths, 1);
});

test("migration audit extends but does not weaken the Phase 0 allowlist", async () => {
  assert.equal(auditEvolutionEngine().files.length, 8);
  assert.equal(auditMigrationEngine().files.length, 10);
  await assert.rejects(withProductionIoGuard(() => fetch("https://example.invalid")), /blocked external I\/O/);
  await assert.rejects(withProductionIoGuard(() => Math.random()), /blocked external I\/O/);
  const source = readFileSync(new URL("../tools/migration-canary.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.submit\(|inheritHeritableTraits|new\s+.*DurableObject|moyo\.bluemoon\.works/);
});

function matchedSummaries() {
  return MIGRATION_MODES.map((mode) => ({
    initialStateHash: "same", run: { schedule: migrationSchedule({ mode }), seed: 3902, completed: true,
      engineHash: "same", implementationHash: "same", scheduleTicks: 8640, maxTravelTicks: 64 },
    migration: migrationSchedule({ mode }).quotas.map((n) => ({ scheduled: n, arrived: n, skipped: 0, failed: 0, inFlight: 0 })),
  }));
}

test("count matching rejects zero arrivals, missing arms, partial runs and confounded setups", () => {
  const good = matchedSummaries();
  assert.ok(compareMigrationRuns(good).every((c) => c.countMatched));
  assert.equal(compareMigrationRuns(good.slice(0, 2))[0].reason, "missing-arm");
  for (const mutate of [
    (s) => { s[1].migration[0].arrived = 0; },
    (s) => { s[1].migration[0].skipped = 1; },
    (s) => { s[1].migration[0].inFlight = 1; },
    (s) => { s[1].run.completed = false; },
    (s) => { s[1].run.seed = 3903; },
    (s) => { s[1].initialStateHash = "different"; },
    (s) => { s[1].run.maxTravelTicks = 32; },
  ]) {
    const changed = structuredClone(good); mutate(changed);
    assert.equal(compareMigrationRuns(changed)[0].countMatched, false);
  }
});

test("real engine replay preserves hashes, migration balance and sample independence", async () => {
  const options = { seed: 3902, ticks: 32, period: 32, maxTravelTicks: 16, sampleEvery: 16 };
  const first = await runMigrationCanary(options);
  const replay = await runMigrationCanary(options);
  assert.equal(first.summary.run.completed, true);
  assert.deepEqual(first.snapshots, replay.snapshots);
  assert.deepEqual(first.events, replay.events);
  assert.equal(first.summary.deterministicResultHash, replay.summary.deterministicResultHash);
  assert.ok(first.summary.migration.some((m) => m.arrived > 0));
  assert.equal(first.summary.lineage.births, 0); assert.equal(first.summary.lineage.deaths, 0);
  const resampled = await runMigrationCanary({ ...options, sampleEvery: 7, collectSnapshots: false });
  assert.equal(resampled.summary.finalStateHash, first.summary.finalStateHash);
  assert.equal(resampled.summary.eventSeriesHash, first.summary.eventSeriesHash);
  assert.deepEqual(resampled.snapshots, []);
  assert.equal(first.summary.snapshotSeriesHash, hash(first.snapshots.map((s) => stableStringify(s) + "\n").join("")));
  assert.equal(first.summary.eventSeriesHash, hash(first.events.map((e) => stableStringify(e) + "\n").join("")));
  const { durationMs, runtimeLimitMs, deterministicResultHash, ...payload } = first.summary;
  assert.equal(deterministicResultHash, hash(stableStringify(payload)));
  for (const m of first.summary.migration) {
    assert.equal(m.scheduled, m.started + m.skipped);
    assert.equal(m.started, m.arrived + m.failed + m.inFlight);
  }
});

test("CLI writes verifiable local artifacts and refuses reuse or unknown modes", () => {
  // realpath avoids the existing Phase 0 guard's /var -> /private/var restriction on macOS.
  const root = mkdtempSync(join(realpathSync(tmpdir()), "migration-canary-"));
  const directory = join(root, "run");
  const script = new URL("../tools/migration-canary.mjs", import.meta.url);
  try {
    const args = [script.pathname, "--mode", "constant", "--ticks", "16", "--period", "16",
      "--max-travel-ticks", "1", "--sample-every", "8", "--output", directory];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(join(directory, "constant", "summary.json"), "utf8"));
    assert.equal(summary.snapshotSeriesHash, hash(readFileSync(join(directory, "constant", "snapshots.jsonl"))));
    assert.equal(summary.eventSeriesHash, hash(readFileSync(join(directory, "constant", "migration.jsonl"))));
    assert.equal(JSON.parse(readFileSync(join(directory, "comparison.json"))).comparisons[0].countMatched, false);
    assert.equal(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 1);
    const invalid = spawnSync(process.execPath, [script.pathname, "--mode", "../evil", "--output", join(root, "bad")], { encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.deepEqual(readdirSync(root), ["run"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime limit returns explicit partial results instead of a completed comparison", async () => {
  const partial = await runMigrationCanary({ period: 16, ticks: 160000, maxRuntimeMs: 1 });
  assert.equal(partial.summary.run.completed, false);
  assert.equal(partial.summary.run.stopReason, "max-runtime-ms");
  assert.equal(partial.snapshots.at(-1).tick, partial.summary.run.completedTicks);
});
