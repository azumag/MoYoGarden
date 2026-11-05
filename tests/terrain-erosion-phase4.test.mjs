import assert from "node:assert/strict";
import test from "node:test";
import {
  UPLIFT_INTERVAL,
  applyTerrainErosion,
  applyTerrainUplift,
  updateTileHydrology,
} from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds } from "../dist-ts/src/world.js";

function allLandTiles(state) {
  return state.tiles.filter((tile) => tile.terrain !== "water" && inBounds(state, tile));
}

function totalSoil(state) {
  let sum = 0;
  for (const tile of allLandTiles(state)) sum += Math.max(0, tile.soilThickness ?? 0);
  return sum;
}

function meanLandElevation(state) {
  const tiles = allLandTiles(state);
  let sum = 0;
  for (const tile of tiles) sum += tile.elevation ?? 0;
  return tiles.length > 0 ? sum / tiles.length : 0;
}

function assertTerrainInvariant(state) {
  for (const tile of allLandTiles(state)) {
    const bedrock = tile.bedrockElevation ?? 0;
    const soil = tile.soilThickness ?? 0;
    const elev = tile.elevation ?? 0;
    assert.ok(Math.abs(bedrock + soil - elev) < 1e-12, `invariant at ${tile.x},${tile.y}: ${bedrock}+${soil}!=${elev}`);
  }
}

test("uplift only does not increase soil amount", () => {
  const state = createInitialWorld({ seed: 9090, width: 16, height: 12 });
  for (const tile of allLandTiles(state)) {
    tile.terrain = "plain";
    delete tile.resource;
    delete tile.flowTo;
  }
  updateTileHydrology(state);
  const soilBefore = totalSoil(state);
  const bedrockBefore = allLandTiles(state).reduce((s, t) => s + (t.bedrockElevation ?? 0), 0);
  const uplifted = applyTerrainUplift(state);
  assert.ok(uplifted > 0);
  const soilAfter = totalSoil(state);
  const bedrockAfter = allLandTiles(state).reduce((s, t) => s + (t.bedrockElevation ?? 0), 0);
  assert.ok(Math.abs(soilAfter - soilBefore) < 1e-12, `soil changed: ${soilBefore} -> ${soilAfter}`);
  assert.ok(bedrockAfter > bedrockBefore + 1e-12);
  assertTerrainInvariant(state);
});

test("if uplift exceeds erosion, long-term mean elevation can rise", () => {
  // Nearly flat/no-flow land so erosion is minimal; uplift still applies.
  const state = createInitialWorld({ seed: 9191, width: 16, height: 12 });
  for (const tile of allLandTiles(state)) {
    tile.terrain = "plain";
    tile.elevation = 0.5;
    tile.bedrockElevation = 0.3;
    tile.soilThickness = 0.2;
    delete tile.resource;
    delete tile.flowTo;
    delete tile.drainage;
    delete tile.erosionPressure;
  }
  updateTileHydrology(state);
  // Remove flow to suppress erosion
  for (const tile of allLandTiles(state)) delete tile.flowTo;
  const elevBefore = meanLandElevation(state);
  for (let i = 0; i < 5; i += 1) {
    applyTerrainUplift(state);
    applyTerrainErosion(state);
  }
  const elevAfter = meanLandElevation(state);
  assert.ok(elevAfter > elevBefore + 1e-9, `mean elevation did not rise: ${elevBefore} -> ${elevAfter}`);
  assertTerrainInvariant(state);
});

test("when uplift is not applied, erosion behavior remains consistent (current behavior)", () => {
  // Erosion-only path (no uplift calls) preserves conservation and invariants.
  const state = createInitialWorld({ seed: 9292, width: 16, height: 12 });
  for (const tile of state.tiles) {
    if (!inBounds(state, tile)) continue;
    tile.terrain = "plain";
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
  updateTileHydrology(state);
  for (const tile of state.tiles) delete tile.flowTo;
  source.flowTo = { x: target.x, y: target.y };
  source.drainage = 2;

  const ledger = applyTerrainErosion(state);
  if (ledger.removed + (ledger.bedrockRemoved ?? 0) > 0) {
    assert.ok(
      Math.abs(ledger.removed + (ledger.bedrockRemoved ?? 0) - (ledger.deposited + ledger.waterExport + ledger.clampLoss)) < 1e-9,
    );
  }
  assertTerrainInvariant(state);
  // Uplift interval constant is independent from erosion interval
  assert.equal(UPLIFT_INTERVAL, 1200);
});

test("after uplift and erosion, all tiles maintain bedrock + soil == elevation (1e-12)", () => {
  const state = createInitialWorld({ seed: 9393, width: 16, height: 12 });
  for (const tile of allLandTiles(state)) {
    tile.terrain = "plain";
    delete tile.resource;
  }
  updateTileHydrology(state);
  // Mix uplift and erosion events
  for (let i = 0; i < 6; i += 1) {
    applyTerrainUplift(state);
    applyTerrainErosion(state);
  }
  assertTerrainInvariant(state);
  for (const tile of allLandTiles(state)) {
    assert.ok((tile.soilThickness ?? 0) >= -1e-12);
    assert.ok((tile.bedrockElevation ?? 0) >= -1e-12);
  }
});
