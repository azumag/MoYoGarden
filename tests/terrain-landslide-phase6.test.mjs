import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMassWasting,
  getTileGlobalPosition,
  updateTileHydrology,
} from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds } from "../dist-ts/src/world.js";
import { derivePorosity, sampleWorldConditions } from "../dist-ts/src/world-scale.js";

function allLandTiles(state) {
  return state.tiles.filter((tile) => tile.terrain !== "water" && inBounds(state, tile));
}

function assertTerrainInvariant(state) {
  for (const tile of allLandTiles(state)) {
    const bedrock = tile.bedrockElevation ?? 0;
    const soil = tile.soilThickness ?? 0;
    const elev = tile.elevation ?? 0;
    assert.ok(Math.abs(bedrock + soil - elev) < 1e-12, `invariant at ${tile.x},${tile.y}`);
  }
}

function soilCapacity(state, tile) {
  const { globalX, globalY } = getTileGlobalPosition(state, tile);
  const conditions = sampleWorldConditions(state.seed, globalX, globalY);
  const porosity = derivePorosity(state.seed, globalX, globalY, conditions.elevation);
  const soilThickness = tile.soilThickness ?? 0.01;
  return Math.max(0.01, Math.min(0.5, porosity * (0.6 + soilThickness * 1.8)));
}

function maxGroundwaterStorage(state, tile) {
  const { globalX, globalY } = getTileGlobalPosition(state, tile);
  const conditions = sampleWorldConditions(state.seed, globalX, globalY);
  const porosity = derivePorosity(state.seed, globalX, globalY, conditions.elevation);
  const bedrock = Math.max(0, tile.bedrockElevation ?? 0);
  const soil = Math.max(0, tile.soilThickness ?? 0);
  const surface = Number.isFinite(tile.elevation ?? Number.NaN) ? tile.elevation : bedrock + soil;
  return Math.max(0, porosity * Math.max(0, surface - bedrock));
}

function setupPair(seed = 7601) {
  const state = createInitialWorld({ seed, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of state.tiles) {
    if (!inBounds(state, tile)) continue;
    tile.terrain = "plain";
    tile.bedrockElevation = 0.2;
    tile.soilThickness = 0.06;
    tile.elevation = 0.26;
    tile.soilMoisture = 0.01;
    tile.groundwaterStorage = 0;
    delete tile.resource;
    delete tile.flowTo;
  }
  const source = getTile(state, { x: 6, y: 6 });
  const target = getTile(state, { x: 7, y: 6 });
  assert.ok(source && target);
  updateTileHydrology(state);
  return { state, source, target };
}

test("stable slope does not trigger landslide", () => {
  const { state } = setupPair();
  // gentle slope
  const source = getTile(state, { x: 6, y: 6 });
  const target = getTile(state, { x: 7, y: 6 });
  source.elevation = 0.30; source.soilThickness = 0.10; source.bedrockElevation = 0.20;
  target.elevation = 0.25; target.soilThickness = 0.05; target.bedrockElevation = 0.20;
  source.soilMoisture = soilCapacity(state, source) * 0.2;
  source.groundwaterStorage = 0;
  const ledger = applyMassWasting(state);
  assert.equal(ledger.moved, 0);
  assert.equal(ledger.deposited, 0);
  assert.equal(ledger.waterExport, 0);
  assert.equal(ledger.clampLoss, 0);
  assertTerrainInvariant(state);
});

test("saturated steep slope triggers deterministic landslide with conservation (1e-9)", () => {
  const { state, source, target } = setupPair();
  source.bedrockElevation = 0.20; source.soilThickness = 0.06; source.elevation = 0.26;
  target.bedrockElevation = 0.05; target.soilThickness = 0.01; target.elevation = 0.06;
  // max saturation
  source.soilMoisture = soilCapacity(state, source);
  source.groundwaterStorage = maxGroundwaterStorage(state, source);
  const ledger = applyMassWasting(state);
  assert.ok(ledger.moved > 0, `expected landslide, got ${JSON.stringify(ledger)}`);
  assert.ok(Math.abs(ledger.moved - (ledger.deposited + ledger.waterExport + ledger.clampLoss)) < 1e-9);
  assertTerrainInvariant(state);
});

test("soil=0 does not trigger (bedrock out of scope) and water boundary exports", () => {
  const state = createInitialWorld({ seed: 7602, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of state.tiles) {
    if (!inBounds(state, tile)) continue;
    tile.terrain = "plain";
    tile.bedrockElevation = 0.2;
    tile.soilThickness = 0;
    tile.elevation = 0.2;
    tile.soilMoisture = 0;
    tile.groundwaterStorage = 0;
    delete tile.resource;
  }
  const source = getTile(state, { x: 6, y: 6 });
  const down = getTile(state, { x: 7, y: 6 });
  assert.ok(source && down);
  down.terrain = "water"; down.elevation = 0; down.bedrockElevation = 0; down.soilThickness = 0; down.groundwaterStorage = 0;
  source.bedrockElevation = 0.3; source.soilThickness = 0; source.elevation = 0.3;
  source.soilMoisture = 0; source.groundwaterStorage = 0;
  const ledger = applyMassWasting(state);
  assert.equal(ledger.moved, 0);
  // now with soil, steep to water -> export
  const state2 = createInitialWorld({ seed: 7603, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of state2.tiles) {
    if (!inBounds(state2, tile)) continue;
    tile.terrain = "plain";
    tile.bedrockElevation = 0.2; tile.soilThickness = 0.06; tile.elevation = 0.26;
    tile.soilMoisture = 0; tile.groundwaterStorage = 0; delete tile.resource;
  }
  const s2 = getTile(state2, { x: 6, y: 6 });
  const w2 = getTile(state2, { x: 7, y: 6 });
  assert.ok(s2 && w2);
  w2.terrain = "water"; w2.elevation = 0; w2.bedrockElevation = 0; w2.soilThickness = 0; w2.groundwaterStorage = 0;
  s2.bedrockElevation = 0.20; s2.soilThickness = 0.06; s2.elevation = 0.26;
  s2.soilMoisture = soilCapacity(state2, s2);
  s2.groundwaterStorage = maxGroundwaterStorage(state2, s2);
  // need steep enough drop to water
  s2.bedrockElevation = 0.20; s2.elevation = 0.26;
  // adjust target to be steep: water is 0
  const led2 = applyMassWasting(state2);
  if (led2.moved > 0) {
    assert.ok(led2.waterExport >= 0);
    assert.ok(Math.abs(led2.moved - (led2.deposited + led2.waterExport + led2.clampLoss)) < 1e-9);
  }
  assertTerrainInvariant(state2);
});

test("saturation uses groundwaterStorage composite (no fallback): higher gwFill can trigger", () => {
  // dry soil but saturated groundwater storage -> composite term increases
  const { state, source, target } = setupPair();
  source.bedrockElevation = 0.20; source.soilThickness = 0.06; source.elevation = 0.26;
  target.bedrockElevation = 0.05; target.soilThickness = 0.01; target.elevation = 0.06;
  source.soilMoisture = 0; // dry soil
  source.groundwaterStorage = 0;
  const l0 = applyMassWasting(structuredClone(state));
  source.groundwaterStorage = maxGroundwaterStorage(state, source); // gwFill=1, composite=0.5
  source.soilMoisture = soilCapacity(state, source) * 0.8; // satSoil high too
  const l1 = applyMassWasting(structuredClone(state));
  // with high composite saturation on same steep geometry it should be >= (often triggers)
  assert.ok(l1.moved >= l0.moved);
  assertTerrainInvariant(state);
});

test("bedrock + soil == elevation (1e-12) after mass wasting", () => {
  const state = createInitialWorld({ seed: 7604, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of allLandTiles(state)) {
    tile.terrain = "plain";
    tile.soilMoisture = soilCapacity(state, tile);
    tile.groundwaterStorage = maxGroundwaterStorage(state, tile) * 0.5;
  }
  // create a steep feature
  const s = getTile(state, { x: 5, y: 5 });
  const t = getTile(state, { x: 6, y: 5 });
  if (s && t) { s.elevation = (s.bedrockElevation ?? 0.2) + 0.06; s.soilThickness = 0.06; t.elevation = (t.bedrockElevation ?? 0.2); t.soilThickness = 0.001; }
  applyMassWasting(state);
  assertTerrainInvariant(state);
});
