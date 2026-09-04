import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import {
  alignRegionBoundaryElevations,
  ensureWorldExtent,
  sampleWorldConditions,
  TARGET_WORLD_HEIGHT,
  TARGET_WORLD_WIDTH,
} from "../dist-ts/src/world-scale.js";
import { createInitialWorld, validateWorldState } from "../dist-ts/src/world.js";

test("legacy default worlds gain a deterministic hex-compatible frontier", () => {
  const legacy = createInitialWorld({ seed: 98765, width: 32, height: 20 });
  const originalTiles = new Map(legacy.tiles.map((tile) => [`${tile.x}:${tile.y}`, structuredClone(tile)]));

  assert.equal(ensureWorldExtent(legacy), true);
  assert.equal(legacy.width, TARGET_WORLD_WIDTH);
  assert.equal(legacy.height, TARGET_WORLD_HEIGHT);
  assert.equal(legacy.tiles.length, TARGET_WORLD_WIDTH * TARGET_WORLD_HEIGHT);

  for (const [key, tile] of originalTiles) {
    const [x, y] = key.split(":").map(Number);
    const next = legacy.tiles[y * legacy.width + x];
    if (isHexGridCell(legacy, { x, y })) assert.deepEqual(next, tile);
  }

  const inactive = legacy.tiles.filter((tile) => !isHexGridCell(legacy, tile));
  assert.ok(inactive.length > 0);
  assert.ok(inactive.every((tile) => tile.terrain === "water" && tile.resource === undefined));

  const frontier = legacy.tiles.filter(
    (tile) => (tile.x >= 32 || tile.y >= 20) && isHexGridCell(legacy, tile),
  );
  assert.ok(frontier.length > 0);
  assert.ok(frontier.every((tile) => Number.isFinite(tile.elevation)));
  assert.deepEqual(validateWorldState(legacy), []);
  assert.equal(ensureWorldExtent(legacy), false);
});

test("absolute environment sampling remains stable regardless of outer storage extent", () => {
  const seed = 13579;
  const coordinates = [
    [0, 0], [17, 9], [39, 23], [80, 48], [-12, 31],
  ];
  const first = coordinates.map(([x, y]) => sampleWorldConditions(seed, x, y));
  const second = coordinates.map(([x, y]) => sampleWorldConditions(seed, x, y));
  assert.deepEqual(first, second);
});

test("world conditions use shared seed plus absolute axial coordinates", () => {
  const seed = 424242;
  const global = sampleWorldConditions(seed, 47, 11);
  assert.deepEqual(global, sampleWorldConditions(seed, 40 + 7, 11));
  assert.notDeepEqual(global, sampleWorldConditions(seed, 48, 11));

  const localSeedA = createInitialWorld({ seed: 111, width: 16, height: 12 });
  const localSeedB = createInitialWorld({ seed: 222, width: 16, height: 12 });
  ensureWorldExtent(localSeedA, 40, 24, { worldSeed: seed, originX: 0, originY: 0 });
  ensureWorldExtent(localSeedB, 40, 24, { worldSeed: seed, originX: 1, originY: 0 });

  const a = localSeedA.tiles[1 * localSeedA.width + 20];
  const b = localSeedB.tiles[1 * localSeedB.width + 19];
  assert.ok(a);
  assert.ok(b);
  assert.equal(20, 1 + 19);
  assert.ok(isHexGridCell(localSeedA, a));
  assert.ok(isHexGridCell(localSeedB, b));
  assert.equal(a.elevation, b.elevation);
  assert.equal(a.terrain, b.terrain);
  assert.deepEqual(a.resource, b.resource);
});

test("persisted hex-side elevations migrate toward the shared global frame without replacing terrain", () => {
  const seed = 424242;
  const region = createInitialWorld({ seed: 991, width: 40, height: 24 });
  const y = 11;
  const edgeX = 8;
  const innerX = 12;
  const edge = region.tiles[y * region.width + edgeX];
  const inner = region.tiles[y * region.width + innerX];
  assert.ok(edge);
  assert.ok(inner);
  assert.ok(isHexGridCell(region, edge));

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
  assert.equal(
    edge.elevation,
    Math.max(0.03, sampleWorldConditions(seed, 40 + edgeX, y).elevation),
  );
  assert.equal(edge.terrain, "forest");
  assert.deepEqual(edge.resource, preservedResource);
  assert.equal(inner.elevation, 0.13);
});

test("terrain conditions derive bounded temperature, six-neighbor slope, convergence and wetness", () => {
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

test("runtime expands persisted default worlds but respects explicit compact hex test worlds", () => {
  const persisted = createInitialWorld({ seed: 24680, width: 32, height: 20 });
  const expanded = new WorldRuntime({ state: persisted }).snapshot();
  assert.equal(expanded.width, TARGET_WORLD_WIDTH);
  assert.equal(expanded.height, TARGET_WORLD_HEIGHT);
  assert.deepEqual(validateWorldState(expanded), []);

  const compact = new WorldRuntime({ seed: 24680, width: 16, height: 12 }).snapshot();
  assert.equal(compact.width, 16);
  assert.equal(compact.height, 12);
  assert.deepEqual(validateWorldState(compact), []);
});
