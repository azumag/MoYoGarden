import assert from "node:assert/strict";
import test from "node:test";
import { applyTerrainErosion, terrainErosionPressureAt, updateTileHydrology } from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds } from "../dist-ts/src/world.js";

function allLandTiles(state) {
  return state.tiles.filter((tile) => tile.terrain !== "water" && inBounds(state, tile));
}

function setupSlopeToPlain(seed = 6060) {
  const state = createInitialWorld({ seed, width: 16, height: 12 });
  for (const tile of state.tiles) {
    if (!inBounds(state, tile)) continue;
    tile.terrain = "plain";
    tile.elevation = 0.5;
    delete tile.bedrockElevation;
    delete tile.soilThickness;
    delete tile.resource;
    delete tile.flowTo;
    delete tile.drainage;
    delete tile.erosionPressure;
  }
  const source = getTile(state, { x: 6, y: 6 });
  const target = getTile(state, { x: 7, y: 6 });
  assert.ok(source && target);
  source.elevation = 0.6;
  target.elevation = 0.4;
  source.flowTo = { x: target.x, y: target.y };
  source.drainage = 2;
  source.resource = { kind: "wood", amount: 0, maxAmount: 10 }; // bare -> higher pressure
  // Initialize layers
  updateTileHydrology(state);
  // restore manual flow for controlled test
  for (const tile of state.tiles) delete tile.flowTo;
  source.flowTo = { x: target.x, y: target.y };
  source.drainage = 2;
  return { state, source, target };
}

test("bedrock does not erode while soil remains (> 0)", () => {
  const { state, source, target } = setupSlopeToPlain();
  assert.ok((source.soilThickness ?? 0) > 1e-9);
  const bedrockBefore = source.bedrockElevation ?? 0;
  const ledger = applyTerrainErosion(state);
  assert.ok(ledger.removed > 0);
  assert.ok(Math.abs(ledger.bedrockRemoved) < 1e-12);
  assert.ok(Math.abs((source.bedrockElevation ?? 0) - bedrockBefore) < 1e-12);
  assert.ok(Math.abs(ledger.removed + ledger.bedrockRemoved - (ledger.deposited + ledger.waterExport + ledger.clampLoss)) < 1e-9);
});

test("bedrock erodes only when soil is depleted", () => {
  const { state, source, target } = setupSlopeToPlain();
  // Deplete soil completely; keep bedrock high enough to erode
  source.soilThickness = 0;
  source.bedrockElevation = 0.6;
  source.elevation = 0.6;
  target.soilThickness = 0;
  target.bedrockElevation = 0.4;
  target.elevation = 0.4;
  source.drainage = 2;
  const bedrockBefore = source.bedrockElevation;
  const pressure = terrainErosionPressureAt(state, source);
  const ledger = applyTerrainErosion(state);
  assert.ok(pressure > 0);
  assert.ok(ledger.bedrockRemoved > 0, `expected bedrock erosion, got ${JSON.stringify(ledger)}`);
  assert.ok(Math.abs(ledger.removed) < 1e-12);
  assert.ok((source.bedrockElevation ?? 0) < bedrockBefore);
  assert.ok(Math.abs(ledger.removed + ledger.bedrockRemoved - (ledger.deposited + ledger.waterExport + ledger.clampLoss)) < 1e-9);
  // bedrock erodes slower than soil would: max 0.0002 * pressure
  assert.ok(ledger.bedrockRemoved <= 0.0002 * pressure + 1e-12);
});

test("bedrock erosion deposits downstream as sediment (soil) on land", () => {
  const { state, source, target } = setupSlopeToPlain();
  source.soilThickness = 0;
  source.bedrockElevation = 0.6;
  source.elevation = 0.6;
  target.soilThickness = 0.01;
  target.bedrockElevation = 0.39;
  target.elevation = 0.4;
  source.drainage = 2;
  const targetSoilBefore = target.soilThickness ?? 0;
  const targetBedrockBefore = target.bedrockElevation ?? 0;
  const ledger = applyTerrainErosion(state);
  assert.ok(ledger.bedrockRemoved > 0);
  assert.ok(ledger.deposited > 0);
  assert.ok(Math.abs(ledger.waterExport) < 1e-12);
  assert.ok((target.soilThickness ?? 0) > targetSoilBefore);
  assert.ok(Math.abs((target.bedrockElevation ?? 0) - targetBedrockBefore) < 1e-12);
});

test("after erosion all tiles maintain bedrock + soil == elevation (1e-12)", () => {
  const { state } = setupSlopeToPlain(7070);
  // Mix of depleted and non-depleted
  for (const tile of allLandTiles(state)) {
    if ((tile.x + tile.y) % 3 === 0) {
      tile.soilThickness = 0;
      tile.elevation = (tile.bedrockElevation ?? 0);
    }
  }
  updateTileHydrology(state);
  // Run a few erosion events via direct application
  for (let i = 0; i < 5; i += 1) {
    applyTerrainErosion(state);
  }
  for (const tile of allLandTiles(state)) {
    const bedrock = tile.bedrockElevation ?? 0;
    const soil = tile.soilThickness ?? 0;
    const elev = tile.elevation ?? 0;
    assert.ok(Math.abs(bedrock + soil - elev) < 1e-12, `invariant at ${tile.x},${tile.y}`);
    assert.ok(soil >= -1e-12);
    assert.ok(bedrock >= -1e-12);
  }
});

test("bedrock erosion ledger records bedrockRemoved and conservation holds (1e-9)", () => {
  const state = createInitialWorld({ seed: 8080, width: 16, height: 12 });
  for (const tile of state.tiles) {
    if (!inBounds(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
    delete tile.flowTo;
    delete tile.drainage;
    delete tile.erosionPressure;
  }
  // Create slope to water with depleted soil
  for (let x = 3; x <= 7; x += 1) {
    const t = getTile(state, { x, y: 6 });
    if (!t) continue;
    t.bedrockElevation = 0.7 - (x - 3) * 0.1;
    t.soilThickness = 0;
    t.elevation = t.bedrockElevation;
  }
  const water = getTile(state, { x: 8, y: 6 });
  if (water) { water.terrain = "water"; water.elevation = 0; water.bedrockElevation = 0; water.soilThickness = 0; }
  updateTileHydrology(state);
  // force flow toward water
  for (let x = 3; x <= 7; x += 1) {
    const t = getTile(state, { x, y: 6 });
    if (t) t.flowTo = { x: x + 1, y: 6 };
  }
  const ledger = applyTerrainErosion(state);
  if (ledger.bedrockRemoved > 0 || ledger.removed > 0) {
    assert.ok(Math.abs(ledger.removed + ledger.bedrockRemoved - (ledger.deposited + ledger.waterExport + ledger.clampLoss)) < 1e-9);
  }
  assert.ok(ledger.bedrockRemoved >= -1e-12);
});
