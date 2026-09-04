import assert from "node:assert/strict";
import test from "node:test";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import {
  alignRegionBoundaryElevations,
  ensureWorldExtent,
  sampleWorldConditions,
  TARGET_WORLD_HEIGHT,
  TARGET_WORLD_WIDTH,
} from "../dist-ts/src/world-scale.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("legacy default worlds gain a deterministic coordinate-stable frontier", () => {
  const legacy = createInitialWorld({ seed: 98765, width: 32, height: 20 });
  const originalTiles = new Map(legacy.tiles.map((tile) => [`${tile.x}:${tile.y}`, structuredClone(tile)]));
  const originalAgents = structuredClone(legacy.agents);

  assert.equal(ensureWorldExtent(legacy), true);
  assert.equal(legacy.width, TARGET_WORLD_WIDTH);
  assert.equal(legacy.height, TARGET_WORLD_HEIGHT);
  assert.equal(legacy.tiles.length, TARGET_WORLD_WIDTH * TARGET_WORLD_HEIGHT);
  assert.deepEqual(legacy.agents, originalAgents);

  for (const [key, tile] of originalTiles) {
    const [x, y] = key.split(":").map(Number);
    assert.deepEqual(legacy.tiles[y * legacy.width + x], tile);
  }

  const frontier = legacy.tiles.filter((tile) => tile.x >= 32 || tile.y >= 20);
  assert.ok(frontier.length > 0);
  assert.ok(frontier.every((tile) => Number.isFinite(tile.elevation)));
  assert.ok(new Set(frontier.map((tile) => tile.terrain)).size >= 2);
  assert.equal(ensureWorldExtent(legacy), false);
});

test("frontier generation does not rescale when the target extent grows", () => {
  const seed = 13579;
  const compact = createInitialWorld({ seed, width: 32, height: 20 });
  const wide = structuredClone(compact);

  ensureWorldExtent(compact, 40, 24);
  ensureWorldExtent(wide, 80, 48);

  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < 40; x += 1) {
      if (x < 32 && y < 20) continue;
      assert.deepEqual(
        compact.tiles[y * compact.width + x],
        wide.tiles[y * wide.width + x],
        `frontier changed at ${x},${y} when the outer extent changed`,
      );
    }
  }
});

test("world conditions use shared seed plus absolute coordinates", () => {
  const seed = 424242;
  const global = sampleWorldConditions(seed, 47, 11);
  assert.deepEqual(global, sampleWorldConditions(seed, 40 + 7, 11));
  assert.notDeepEqual(global, sampleWorldConditions(seed, 48, 11));

  const localSeedA = createInitialWorld({ seed: 111, width: 32, height: 20 });
  const localSeedB = createInitialWorld({ seed: 222, width: 32, height: 20 });
  ensureWorldExtent(localSeedA, 40, 24, { worldSeed: seed, originX: 0, originY: 0 });
  ensureWorldExtent(localSeedB, 40, 24, { worldSeed: seed, originX: 7, originY: 0 });

  const a = localSeedA.tiles[11 * localSeedA.width + 39];
  const b = localSeedB.tiles[11 * localSeedB.width + 32];
  assert.ok(a);
  assert.ok(b);
  assert.equal(39, 7 + 32);
  assert.equal(a.elevation, b.elevation);
  assert.equal(a.terrain, b.terrain);
  assert.deepEqual(a.resource, b.resource);
});

test("persisted region edge elevations migrate toward the shared global frame without replacing terrain", () => {
  const seed = 424242;
  const region = createInitialWorld({ seed: 991, width: 40, height: 24 });
  const y = 10;
  const edge = region.tiles[y * region.width];
  const inner = region.tiles[y * region.width + 4];
  assert.ok(edge);
  assert.ok(inner);

  edge.terrain = "forest";
  edge.resource = { kind: "wood", amount: 7, maxAmount: 31 };
  edge.elevation = 0.9;
  inner.elevation = 0.13;
  const preservedResource = structuredClone(edge.resource);

  const changed = alignRegionBoundaryElevations(
    region,
    seed,
    40,
    0,
    { west: true },
    4,
  );

  assert.ok(changed > 0);
  assert.equal(edge.elevation, Math.max(0.03, sampleWorldConditions(seed, 40, y).elevation));
  assert.equal(edge.terrain, "forest");
  assert.deepEqual(edge.resource, preservedResource);
  assert.equal(inner.elevation, 0.13);
});

test("terrain conditions derive bounded temperature, slope, convergence and wetness from the same field", () => {
  const seed = 424242;
  const samples = [];
  for (let y = 0; y < 24; y += 3) {
    for (let x = 0; x < 40; x += 3) {
      samples.push(sampleWorldConditions(seed, x, y));
    }
  }

  for (const sample of samples) {
    for (const value of [
      sample.elevation,
      sample.moisture,
      sample.temperature,
      sample.slope,
      sample.convergence,
      sample.wetness,
    ]) {
      assert.ok(Number.isFinite(value));
      assert.ok(value >= 0 && value <= 1);
    }
  }

  assert.ok(Math.max(...samples.map((sample) => sample.slope)) - Math.min(...samples.map((sample) => sample.slope)) > 0.1);
  assert.ok(Math.max(...samples.map((sample) => sample.wetness)) - Math.min(...samples.map((sample) => sample.wetness)) > 0.1);
  assert.ok(Math.max(...samples.map((sample) => sample.temperature)) - Math.min(...samples.map((sample) => sample.temperature)) > 0.1);
  assert.ok(samples.some((sample) => Math.abs(sample.wetness - sample.moisture) > 0.01));
});

test("continuous temperature field stays smooth across future region boundaries", () => {
  const seed = 424242;
  const boundaryPairs = [
    [39, 10, 40, 10],
    [19, 23, 20, 24],
    [59, 35, 60, 35],
  ];

  for (const [ax, ay, bx, by] of boundaryPairs) {
    const a = sampleWorldConditions(seed, ax, ay);
    const b = sampleWorldConditions(seed, bx, by);
    assert.ok(Math.abs(a.temperature - b.temperature) < 0.16);
  }

  const climateBand = [];
  for (let y = 0; y <= 256; y += 8) {
    climateBand.push(sampleWorldConditions(seed, 12, y).temperature);
  }
  assert.ok(Math.max(...climateBand) - Math.min(...climateBand) > 0.15);
});

test("runtime expands persisted default worlds but respects explicit compact test worlds", () => {
  const persisted = createInitialWorld({ seed: 24680, width: 32, height: 20 });
  const expanded = new WorldRuntime({ state: persisted }).snapshot();
  assert.equal(expanded.width, TARGET_WORLD_WIDTH);
  assert.equal(expanded.height, TARGET_WORLD_HEIGHT);

  const compact = new WorldRuntime({ seed: 24680, width: 16, height: 12 }).snapshot();
  assert.equal(compact.width, 16);
  assert.equal(compact.height, 12);
});
