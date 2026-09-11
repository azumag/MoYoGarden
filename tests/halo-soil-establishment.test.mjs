import assert from "node:assert/strict";
import test from "node:test";
import { HEX_GRID_STEPS } from "../dist-ts/src/hex-grid.js";
import {
  resourceRegrowthChanceWithHalo,
  surfaceMoistureWithHaloAt,
} from "../dist-ts/src/halo-environment.js";
import { resourceRegrowthChance } from "../dist-ts/src/simulation.js";
import { regionGlobalCellOrigin } from "../dist-ts/src/region-topology.js";
import {
  organicTemperatureSuitability,
  sampleWorldConditions,
} from "../dist-ts/src/world-scale.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const WORLD_SEED = 424242;
const EPSILON = 1e-12;

function approximate(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= EPSILON, `${message}: expected ${expected}, got ${actual}`);
}

function expectedFoodEstablishmentFactor(conditions) {
  const fertilityFactor = 0.5 + conditions.soilFertility * 0.5;
  const temperatureFactor = 0.9 +
    organicTemperatureSuitability("food", conditions.temperature) * 0.1;
  return fertilityFactor * temperatureFactor;
}

test("shared soil and temperature gate local propagule establishment in global hex space", () => {
  const state = createInitialWorld({ seed: 9407, width: 40, height: 24, regionId: "garden-1" });
  for (const entry of state.tiles) {
    entry.terrain = "plain";
    entry.elevation = 0.8;
    entry.drainage = 0;
    delete entry.flowTo;
    delete entry.resource;
  }

  const tile = state.tiles.find((entry) => entry.x === 19 && entry.y === 11);
  assert.ok(tile);
  tile.resource = { kind: "food", amount: 0, maxAmount: 10 };
  for (const step of HEX_GRID_STEPS) {
    const neighbor = state.tiles.find(
      (entry) => entry.x === tile.x + step.x && entry.y === tile.y + step.y,
    );
    assert.ok(neighbor);
    neighbor.resource = { kind: "food", amount: 10, maxAmount: 10 };
  }

  let least;
  let most;
  for (let q = -6; q <= 6; q += 1) {
    for (let r = -6; r <= 6; r += 1) {
      const regionId = `hex-q${q}-r${r}`;
      const origin = regionGlobalCellOrigin(regionId, state.width, state.height);
      assert.ok(origin, `missing global origin for ${regionId}`);
      const conditions = sampleWorldConditions(
        WORLD_SEED,
        origin.x + tile.x,
        origin.y + tile.y,
      );
      const candidate = {
        fertility: conditions.soilFertility,
        conditions,
        frame: { worldSeed: WORLD_SEED, originX: origin.x, originY: origin.y },
      };
      if (least === undefined || candidate.fertility < least.fertility) least = candidate;
      if (most === undefined || candidate.fertility > most.fertility) most = candidate;
    }
  }
  assert.ok(least && most);
  assert.ok(most.fertility - least.fertility > 0.15);

  const localChance = resourceRegrowthChance(state, tile);
  const compatibilityChance = resourceRegrowthChanceWithHalo(state, tile, []);
  const lowChance = resourceRegrowthChanceWithHalo(state, tile, [], least.frame);
  const highChance = resourceRegrowthChanceWithHalo(state, tile, [], most.frame);
  const lowMoisture = surfaceMoistureWithHaloAt(state, tile, [], least.frame);
  const highMoisture = surfaceMoistureWithHaloAt(state, tile, [], most.frame);
  const lowEstablishment = expectedFoodEstablishmentFactor(least.conditions);
  const highEstablishment = expectedFoodEstablishmentFactor(most.conditions);

  approximate(compatibilityChance, localChance + 0.04, "frame-free compatibility bonus");
  approximate(
    lowChance,
    Math.min(0.34, 0.06 + lowMoisture * 0.26 + 0.04 * lowEstablishment),
    "low-fertility establishment bonus",
  );
  approximate(
    highChance,
    Math.min(0.34, 0.06 + highMoisture * 0.26 + 0.04 * highEstablishment),
    "high-fertility establishment bonus",
  );
  assert.ok(lowEstablishment <= 0.5 + least.fertility * 0.5 + EPSILON);
  assert.ok(highEstablishment <= 0.5 + most.fertility * 0.5 + EPSILON);
  assert.ok(
    organicTemperatureSuitability("food", least.conditions.temperature) < 0.999 ||
      organicTemperatureSuitability("food", most.conditions.temperature) < 0.999,
  );
  assert.ok(lowChance < compatibilityChance);
  assert.ok(highChance <= compatibilityChance + EPSILON);
});
