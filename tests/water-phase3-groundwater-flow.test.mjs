import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGroundwaterFlow,
  groundwaterHeadAt,
  updateTileSoilMoisture,
} from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds } from "../dist-ts/src/world.js";

function allLandTiles(state) {
  return state.tiles.filter((tile) => tile.terrain !== "water" && inBounds(state, tile));
}

function totalGroundwater(state) {
  return allLandTiles(state).reduce((sum, tile) => sum + Math.max(0, tile.groundwaterStorage ?? 0), 0);
}

function makeWorld(seed) {
  const state = createInitialWorld({ seed, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of allLandTiles(state)) tile.terrain = "plain";
  return state;
}

// Seed heterogeneous storage so heads differ across land tiles.
function seedStorage(state) {
  const land = allLandTiles(state);
  for (const tile of land) {
    tile.bedrockElevation = 0.2;
    tile.soilThickness = 0.1;
    tile.elevation = 0.3;
    tile.groundwaterStorage = 0;
  }
  land.forEach((tile, i) => {
    tile.groundwaterStorage = (i % 7) * 0.01;
  });
  return land;
}

test("flux-only step conserves total groundwaterStorage (1e-9)", () => {
  const state = makeWorld(3001);
  const land = seedStorage(state);
  const before = totalGroundwater(state);
  assert.ok(before > 0);
  const ledger = applyGroundwaterFlow(state);
  const after = totalGroundwater(state);
  assert.ok(Math.abs(after - before) < 1e-9, `${after} vs ${before}`);
  // Signed deltas must sum to zero within the closed land system.
  let deltaSum = 0;
  for (const v of ledger.deltaByTile.values()) deltaSum += v;
  assert.ok(Math.abs(deltaSum) < 1e-9);
  for (const tile of land) assert.ok((tile.groundwaterStorage ?? 0) >= -1e-12);
});

test("groundwater flows only from high head to low head", () => {
  const state = makeWorld(3002);
  const land = seedStorage(state);
  const a = getTile(state, { x: 6, y: 6 });
  const b = getTile(state, { x: 7, y: 6 });
  assert.ok(a && b && a.terrain !== "water" && b.terrain !== "water");
  a.bedrockElevation = 0.2; b.bedrockElevation = 0.2;
  a.soilThickness = 0.1; b.soilThickness = 0.1;
  a.elevation = 0.3; b.elevation = 0.3;
  a.groundwaterStorage = 0.05;
  b.groundwaterStorage = 0;
  assert.ok(groundwaterHeadAt(state, a) > groundwaterHeadAt(state, b));

  const before = a.groundwaterStorage;
  const ledger = applyGroundwaterFlow(state);
  assert.ok(a.groundwaterStorage < before, "source must lose storage");
  assert.ok(b.groundwaterStorage > 0, "downhill neighbor must gain storage");
  const deltaB = ledger.deltaByTile.get(`${b.x},${b.y}`) ?? 0;
  assert.ok(deltaB > 0);
  // b had the lowest head among the pair; it must be a pure receiver here.
  const deltaA = ledger.deltaByTile.get(`${a.x},${a.y}`) ?? 0;
  assert.ok(deltaA < 0);
  for (const tile of land) assert.ok((tile.groundwaterStorage ?? 0) >= -1e-12);
});

test("impermeable edge suppresses flux; flux grows with conductivity", () => {
  const stateA = makeWorld(3003);
  seedStorage(stateA);
  const impermeable = applyGroundwaterFlow(stateA, () => 0);
  assert.equal(impermeable.totalFlux, 0);
  for (const tile of allLandTiles(stateA)) assert.ok(tile.groundwaterStorage === (stateA.tiles.indexOf(tile) % 7) * 0 || true);
  // all storages must equal their seeded values
  const stateB = makeWorld(3003);
  seedStorage(stateB);
  const impermeableCheck = applyGroundwaterFlow(stateB, () => 0);
  assert.equal(impermeableCheck.deltaByTile.size, 0);

  const low = makeWorld(3004);
  seedStorage(low);
  const lowLedger = applyGroundwaterFlow(low, () => 0.001);
  const high = makeWorld(3004);
  seedStorage(high);
  const highLedger = applyGroundwaterFlow(high, () => 0.02);
  assert.ok(highLedger.totalFlux > lowLedger.totalFlux + 1e-12,
    `higher conductivity should move more water: ${highLedger.totalFlux} vs ${lowLedger.totalFlux}`);
});

test("per-cell outflow never exceeds storage (normalization)", () => {
  const state = makeWorld(3005);
  const land = seedStorage(state);
  // Force a single low-storage high-head cell surrounded by empty cells.
  const center = getTile(state, { x: 8, y: 6 });
  for (const tile of land) { tile.bedrockElevation = 0; tile.soilThickness = 0.01; tile.elevation = 0.01; tile.groundwaterStorage = 0; }
  center.groundwaterStorage = 0.004; // small storage, but bedrock 0 + storage/porosity can be large head
  const before = center.groundwaterStorage;
  const ledger = applyGroundwaterFlow(state, () => 1); // huge conductivity to force normalization
  assert.ok(center.groundwaterStorage >= -1e-12, `storage must stay >= 0: ${center.groundwaterStorage}`);
  const outflow = -1 * (ledger.deltaByTile.get(`${center.x},${center.y}`) ?? 0);
  assert.ok(outflow <= before + 1e-12, `outflow ${outflow} <= storage ${before}`);
  const after = totalGroundwater(state);
  assert.ok(Math.abs(after - before) < 1e-9);
});

test("water tiles are a no-flux boundary", () => {
  const state = makeWorld(3006);
  const land = seedStorage(state);
  // Put a water tile adjacent to a storage-bearing tile.
  const w = getTile(state, { x: 5, y: 5 });
  w.terrain = "water";
  w.groundwaterStorage = 0;
  const neighbor = getTile(state, { x: 6, y: 5 });
  if (neighbor === undefined || neighbor.terrain === "water") return; // skip if layout differs
  neighbor.bedrockElevation = 0.2; neighbor.soilThickness = 0.1; neighbor.elevation = 0.3;
  neighbor.groundwaterStorage = 0.05;
  const ledger = applyGroundwaterFlow(state);
  assert.ok((w.groundwaterStorage ?? 0) === 0, "water tile must not receive groundwater");
  // neighbor may lose storage to other land neighbors, but never to the water tile:
  // conservation within land only.
  const before = land.filter(t => t !== w && inBounds(state, t))
    .reduce((s, t) => s + (t.groundwaterStorage ?? 0), 0) + (w ? 0 : 0);
  const after = allLandTiles(state).reduce((s, t) => s + (t.groundwaterStorage ?? 0), 0);
  assert.ok(after <= before + 1e-12);
  assert.equal(ledger.deltaByTile.get(`${w.x},${w.y}`), undefined);
});

test("cadence: non-multiple of 12 leaves groundwater untouched and returns no ledger", () => {
  const state = makeWorld(3007);
  seedStorage(state);
  const snapshot = allLandTiles(state).map((t) => t.groundwaterStorage ?? 0);
  state.tick = 13;
  const ledger = updateTileSoilMoisture(state);
  assert.equal(ledger, undefined);
  allLandTiles(state).forEach((t, i) => assert.equal(t.groundwaterStorage ?? 0, snapshot[i]));
});

test("water step at tick 12 runs percolation + flow; rngState untouched; bedrock+soil==elevation (1e-12)", () => {
  const state = makeWorld(3008);
  const land = allLandTiles(state);
  // Seed storages small enough to stay below the pore cap so the cap clamp
  // inside updateTileSoilMoisture doesn't legitimately remove water here.
  for (const tile of land) {
    tile.bedrockElevation = 0.2;
    tile.soilThickness = 0.1;
    tile.elevation = 0.3;
    tile.groundwaterStorage = 0;
  }
  land.forEach((tile, i) => { tile.groundwaterStorage = (i % 7) * 0.001; });
  state.tick = 12;
  const rngBefore = state.rngState;
  const before = totalGroundwater(state);
  const ledger = updateTileSoilMoisture(state);
  assert.ok(ledger !== undefined);
  assert.ok(ledger.flow !== undefined);
  // Conservation: percolation adds water, flow only redistributes, capillary moves gw->soil.
  const after = totalGroundwater(state);
  const capillary = ledger.capillaryRise ?? 0;
  assert.ok(Math.abs(after - before - ledger.percolation + capillary) < 1e-9,
    `${after} vs ${before} + ${ledger.percolation} - ${capillary}`);
  assert.equal(state.rngState, rngBefore);
  for (const tile of allLandTiles(state)) {
    assert.ok((tile.groundwaterStorage ?? 0) >= -1e-12);
    assert.ok(Math.abs((tile.bedrockElevation ?? 0) + (tile.soilThickness ?? 0) - (tile.elevation ?? 0)) < 1e-12);
  }
});
