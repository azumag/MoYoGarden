import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildSnapshot,
  runEvolutionCanary,
  withProductionIoGuard,
} from "../tools/evolution-canary.mjs";
import { createInitialWorld } from "../dist-ts/src/world.js";

const SMOKE_TICKS = 256;
const SAMPLE_EVERY = 64;

test("evolution canary is deterministic for the same seed and config", async () => {
  const options = {
    seed: 3902,
    ticks: SMOKE_TICKS,
    sampleEvery: SAMPLE_EVERY,
    commit: "deterministic-smoke",
  };
  const first = await runEvolutionCanary(options);
  const repeated = await runEvolutionCanary(options);

  assert.deepEqual(first.snapshots, repeated.snapshots);
  assert.equal(first.summary.deterministicResultHash, repeated.summary.deterministicResultHash);
  assert.equal(first.summary.run.completed, true);
  assert.equal(first.summary.run.completedTicks, SMOKE_TICKS);
});

test("three deterministic smoke seeds produce distinct observed canary results", async () => {
  const results = [];
  for (const seed of [3901, 3902, 3903]) {
    const result = await runEvolutionCanary({
      seed,
      ticks: SMOKE_TICKS,
      sampleEvery: SAMPLE_EVERY,
      commit: "three-seed-smoke",
    });
    const final = result.snapshots.at(-1);
    assert.ok(final);
    results.push({
      seed,
      finalPopulation: final.population.living,
      births: result.summary.lineage.births,
      deaths: result.summary.lineage.deaths,
      foodDeposits: final.environment.tileDeposits.amountByKind.food,
      resourceLayoutHash: final.environment.tileDeposits.resourceLayoutHash,
      vitalityMean: final.traits.vitality.mean,
      carryingCapacityMean: final.traits.carryingCapacity.mean,
      durationMs: result.summary.durationMs,
      hash: result.summary.deterministicResultHash,
    });
  }

  assert.equal(new Set(results.map((entry) => entry.hash)).size, results.length);
  assert.equal(
    new Set(results.map((entry) => entry.resourceLayoutHash)).size,
    results.length,
    "different seeds must alter an observed environment metric",
  );
  console.log(`EVOLUTION_CANARY_SMOKE ${JSON.stringify(results)}`);
});

test("legacy founders without explicit traits are observed as neutral 1.0", () => {
  const state = createInitialWorld({ seed: 3904 });
  for (const agent of state.agents) delete agent.heritableTraits;

  const snapshot = buildSnapshot(state);
  assert.equal(snapshot.traits.founderCount, state.agents.length);
  assert.equal(snapshot.traits.lineageBornCount, 0);
  assert.equal(snapshot.traits.vitality.mean, 1);
  assert.equal(snapshot.traits.vitality.min, 1);
  assert.equal(snapshot.traits.vitality.max, 1);
  assert.equal(snapshot.traits.carryingCapacity.mean, 1);
});

test("production I/O guard rejects network access and runner stays on local runtime modules", async () => {
  await assert.rejects(
    withProductionIoGuard(async () => fetch("https://example.invalid/")),
    /blocked external I\/O via fetch/,
  );

  const source = await readFile(new URL("../tools/evolution-canary.mjs", import.meta.url), "utf8");
  assert.match(source, /runtime\.tick\(\)/);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:worker|wrangler|cloudflare)/i);
  assert.doesNotMatch(source, /\bDurableObject\b/);
  assert.doesNotMatch(source, /moyo\.bluemoon\.works|workers\.dev/i);
  assert.doesNotMatch(source, /\bfitness\b/i);
  assert.doesNotMatch(source, /inheritHeritableTraits/);
});
