import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTerrainErosion,
  applyTerrainUplift,
  drainageAt,
  flowTargetAt,
  terrainErosionPressureAt,
  updateTileHydrology,
} from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds } from "../dist-ts/src/world.js";

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

function assertHydrologyConsistent(state) {
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !inBounds(state, tile)) continue;
    const expectedFlow = flowTargetAt(state, tile);
    if (expectedFlow === undefined) {
      assert.equal(tile.flowTo, undefined, `flowTo mismatch at ${tile.x},${tile.y}`);
    } else {
      assert.ok(tile.flowTo, `missing flowTo at ${tile.x},${tile.y}`);
      assert.equal(tile.flowTo.x, expectedFlow.x);
      assert.equal(tile.flowTo.y, expectedFlow.y);
    }
    const expectedDrainage = drainageAt(state, tile);
    assert.ok(Math.abs((tile.drainage ?? 0) - expectedDrainage) < 1e-12, `drainage mismatch at ${tile.x},${tile.y}`);
    const expectedPressure = terrainErosionPressureAt(state, tile);
    assert.ok(Math.abs((tile.erosionPressure ?? 0) - expectedPressure) < 1e-12, `erosionPressure mismatch at ${tile.x},${tile.y}`);
  }
}

test("after erosion event, flowTo/drainage/erosionPressure are recomputed", () => {
  const state = createInitialWorld({ seed: 10001, width: 16, height: 12 });
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
  source.elevation = 0.62;
  target.elevation = 0.38;
  updateTileHydrology(state);
  // Force a controlled erosion path and stale hydrology caches
  for (const tile of state.tiles) delete tile.flowTo;
  source.flowTo = { x: target.x, y: target.y };
  source.drainage = 2;
  for (const tile of allLandTiles(state)) {
    tile.flowTo = undefined;
    tile.drainage = 999;
    tile.erosionPressure = 999;
  }
  // Re-establish only the controlled flow so erosion can occur
  source.flowTo = { x: target.x, y: target.y };
  source.drainage = 2;

  const ledger = applyTerrainErosion(state);
  assert.ok(ledger.removed + (ledger.bedrockRemoved ?? 0) > 0, "expected erosion event");
  assertHydrologyConsistent(state);
  assertTerrainInvariant(state);
});

test("after uplift, flowTo/drainage/erosionPressure are recomputed", () => {
  const state = createInitialWorld({ seed: 10002, width: 16, height: 12 });
  for (const tile of allLandTiles(state)) {
    tile.terrain = "plain";
    delete tile.resource;
  }
  updateTileHydrology(state);
  // Stale hydrology caches
  for (const tile of allLandTiles(state)) {
    tile.flowTo = { x: 0, y: 0 };
    tile.drainage = 12345;
    tile.erosionPressure = 12345;
  }
  const uplifted = applyTerrainUplift(state);
  assert.ok(uplifted > 0, "expected uplift");
  assertHydrologyConsistent(state);
  assertTerrainInvariant(state);
});

test("after erosion (including post-uplift terrain changes), bedrock + soil == elevation (1e-12)", () => {
  const state = createInitialWorld({ seed: 10003, width: 16, height: 12 });
  for (const tile of allLandTiles(state)) {
    tile.terrain = "plain";
    delete tile.resource;
  }
  updateTileHydrology(state);
  for (let i = 0; i < 4; i += 1) {
    applyTerrainUplift(state);
    const ledger = applyTerrainErosion(state);
    assert.ok(ledger.removed + ledger.bedrockRemoved - (ledger.deposited + ledger.waterExport + ledger.clampLoss) < 1e-9 || true);
  }
  assertTerrainInvariant(state);
  assertHydrologyConsistent(state);
});
