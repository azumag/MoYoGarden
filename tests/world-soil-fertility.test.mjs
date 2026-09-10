import assert from "node:assert/strict";
import test from "node:test";
import { sampleWorldConditions } from "../dist-ts/src/world-scale.js";

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function expectedSoilFertility(conditions) {
  const temperatureSuitability = clamp01(
    1 - Math.abs(conditions.temperature - 0.58) / 0.58,
  );
  return clamp01(
    conditions.wetness * 0.42 +
    conditions.convergence * 0.18 +
    temperatureSuitability * 0.24 +
    (1 - conditions.slope) * 0.16,
  );
}

test("soil fertility is a bounded low-level consequence of shared world conditions", () => {
  const seed = 424242;
  const samples = [];
  for (let y = -48; y <= 48; y += 8) {
    for (let x = -48; x <= 48; x += 8) {
      const conditions = sampleWorldConditions(seed, x, y);
      assert.ok(Number.isFinite(conditions.soilFertility));
      assert.ok(conditions.soilFertility >= 0 && conditions.soilFertility <= 1);
      assert.ok(
        Math.abs(conditions.soilFertility - expectedSoilFertility(conditions)) < 1e-12,
      );
      samples.push(conditions.soilFertility);
    }
  }

  assert.ok(Math.max(...samples) - Math.min(...samples) > 0.05);
});

test("soil fertility stays deterministic in absolute axial world space", () => {
  const seed = 91731;
  const coordinates = [
    [39, 10],
    [40, 10],
    [19, 23],
    [20, 24],
    [-1, 0],
    [0, 0],
  ];

  const first = coordinates.map(([x, y]) => sampleWorldConditions(seed, x, y).soilFertility);
  const second = coordinates.map(([x, y]) => sampleWorldConditions(seed, x, y).soilFertility);
  assert.deepEqual(first, second);
});
