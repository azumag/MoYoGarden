import assert from "node:assert/strict";
import test from "node:test";
import { HEX_GRID_STEPS } from "../dist-ts/src/hex-grid.js";
import {
  sampleWorldConditions,
  sampleWorldMicroVariation,
} from "../dist-ts/src/world-scale.js";

test("global environmental microvariation is deterministic, bounded, and locally coherent", () => {
  const seed = 424242;
  const samples = [];
  let largestNeighborDelta = 0;

  for (let y = -48; y <= 48; y += 4) {
    for (let x = -48; x <= 48; x += 4) {
      const value = sampleWorldMicroVariation(seed, x, y);
      samples.push(value);
      assert.equal(value, sampleWorldMicroVariation(seed, x, y));
      assert.ok(value >= -0.5 && value <= 0.5);

      for (const step of HEX_GRID_STEPS) {
        const neighbor = sampleWorldMicroVariation(seed, x + step.x, y + step.y);
        largestNeighborDelta = Math.max(largestNeighborDelta, Math.abs(value - neighbor));
      }
    }
  }

  assert.ok(largestNeighborDelta < 0.25, `adjacent microvariation jumped by ${largestNeighborDelta}`);
  assert.ok(Math.max(...samples) - Math.min(...samples) > 0.35);
});

test("global environmental microvariation remains keyed by the shared world seed", () => {
  const coordinates = [
    [0, 0],
    [7, -3],
    [19, 11],
    [46, -1],
    [-23, 11],
    [64, -48],
    [-37, -29],
  ];
  const first = coordinates.map(([x, y]) => sampleWorldMicroVariation(424242, x, y));
  const second = coordinates.map(([x, y]) => sampleWorldMicroVariation(424243, x, y));

  assert.notDeepEqual(first, second);
  assert.ok(
    first.some((value, index) => Math.abs(value - second[index]) > 0.05),
    "different world seeds should materially alter the microvariation field",
  );
});

test("fresh world conditions stay smooth across macro-region-scale coordinate seams", () => {
  const seed = 424242;
  const seamPairs = [
    [22, 11, 23, 11],
    [45, 0, 46, -1],
    [-24, 12, -23, 11],
    [0, -23, 0, -22],
  ];

  for (const [ax, ay, bx, by] of seamPairs) {
    const a = sampleWorldConditions(seed, ax, ay);
    const b = sampleWorldConditions(seed, bx, by);
    assert.ok(Math.abs(a.elevation - b.elevation) < 0.18);
    assert.ok(Math.abs(a.moisture - b.moisture) < 0.18);
    assert.ok(Math.abs(a.temperature - b.temperature) < 0.18);
  }
});
