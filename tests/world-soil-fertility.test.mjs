import assert from "node:assert/strict";
import test from "node:test";
import { createRandom } from "../dist-ts/src/prng.js";
import {
  createGlobalTerrainTile,
  organicTemperatureSuitability,
  sampleWorldConditions,
  scaleOrganicCarryingCapacity,
} from "../dist-ts/src/world-scale.js";

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function expectedSoilFertility(conditions) {
  const temperatureSuitability = clamp01(
    1 - Math.abs(conditions.temperature - 0.58) / 0.58,
  );
  const waterloggingStress = clamp01((conditions.wetness - 0.78) / 0.22);
  return clamp01(
    conditions.wetness * 0.42 +
    conditions.convergence * 0.18 +
    temperatureSuitability * 0.24 +
    (1 - conditions.slope) * 0.16 -
    waterloggingStress * 0.18,
  );
}

function coordinateSeed(seed, x, y) {
  const xHash = Math.imul(x + 1, 0x9e3779b1);
  const yHash = Math.imul(y + 1, 0x85ebca6b);
  return (seed ^ xHash ^ yHash ^ 0x27d4eb2d) >>> 0;
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

test("wood and forage derive overlapping but distinct temperature niches", () => {
  assert.equal(organicTemperatureSuitability("wood", 0.54), 1);
  assert.equal(organicTemperatureSuitability("food", 0.62), 1);
  assert.ok(
    organicTemperatureSuitability("wood", 0.32) >
      organicTemperatureSuitability("food", 0.32),
  );
  assert.ok(
    organicTemperatureSuitability("food", 0.84) >
      organicTemperatureSuitability("wood", 0.84),
  );

  for (const temperature of [-1, 0, 0.5, 1, 2]) {
    for (const kind of ["wood", "food"]) {
      const value = organicTemperatureSuitability(kind, temperature);
      assert.ok(Number.isFinite(value));
      assert.ok(value >= 0 && value <= 1);
    }
  }
});

test("derived soil fertility changes fresh forest carrying capacity", () => {
  const seed = 424242;
  let sample;

  for (let y = -80; y <= 80 && sample === undefined; y += 1) {
    for (let x = -80; x <= 80; x += 1) {
      const conditions = sampleWorldConditions(seed, x, y);
      const fertilityDelta = Math.round((conditions.soilFertility - 0.5) * 8);
      if (fertilityDelta === 0) continue;
      const tile = createGlobalTerrainTile(x, y, seed, 0, 0);
      if (tile.resource?.kind !== "wood") continue;
      sample = { x, y, conditions, fertilityDelta, tile };
      break;
    }
  }

  assert.ok(sample, "expected a forest sample with a non-zero fertility capacity delta");
  const temperatureSuitability = organicTemperatureSuitability(
    "wood",
    sample.conditions.temperature,
  );
  const random = createRandom(coordinateSeed(seed, sample.x, sample.y));
  const moistureAndClimateCapacity =
    random.int(18, 28) +
    Math.round(sample.conditions.wetness * 10) +
    Math.round(temperatureSuitability * 4);
  const fertilityAdjustedBase = moistureAndClimateCapacity + sample.fertilityDelta;
  const expectedCapacity = scaleOrganicCarryingCapacity(
    fertilityAdjustedBase,
    sample.conditions.soilFertility,
  );

  assert.equal(sample.tile.resource.maxAmount, expectedCapacity);
  assert.equal(sample.tile.resource.amount, expectedCapacity);
  assert.notEqual(sample.tile.resource.maxAmount, moistureAndClimateCapacity);
});
