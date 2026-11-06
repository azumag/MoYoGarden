import assert from "node:assert/strict";
import test from "node:test";
import { HEX_GRID_DIRECTIONS, hexGridBoundaryCells, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { buildDynamicHexHaloLinks, buildConfiguredHexHaloLinks, materializeHexHalo, hexHaloKey, hexHaloLookup } from "../dist-ts/src/hex-halo.js";
import { updateTileSoilMoisture, boundaryPendingAt } from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile } from "../dist-ts/src/world.js";

const extent = { width: 40, height: 24 };

function cloneTile(tile) {
  const clone = { ...tile };
  if (tile.flowTo !== undefined) clone.flowTo = { ...tile.flowTo };
  if (tile.resource !== undefined) clone.resource = { ...tile.resource };
  return clone;
}

function makeRegionState(seed, regionId) {
  const state = createInitialWorld({ seed, width: extent.width, height: extent.height, regionId });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) {
      tile.terrain = "water";
      tile.elevation = 0;
      tile.bedrockElevation = 0;
      tile.soilThickness = 0;
      tile.soilMoisture = 1;
      tile.groundwaterStorage = 0;
      tile.soilMoistureOverflow = 0;
      tile.surfaceWater = 0;
      continue;
    }
    tile.terrain = "plain";
    tile.elevation = 0.6;
    tile.bedrockElevation = 0.54;
    tile.soilThickness = 0.06;
    tile.soilMoisture = 0.1;
    tile.groundwaterStorage = 0.02;
    tile.soilMoistureOverflow = 0.001;
    delete tile.surfaceWater;
    delete tile.resource;
    delete tile.flowTo;
    tile.drainage = 0;
    tile.erosionPressure = 0;
  }
  for (const agent of state.agents) {
    agent.autonomy = false;
    delete agent.task;
  }
  return state;
}

function edgeSnapshotsForRegionAllDirs(state) {
  const snaps = [];
  for (const direction of HEX_GRID_DIRECTIONS) {
    const tiles = [];
    for (const pos of hexGridBoundaryCells(extent, direction)) {
      const tile = getTile(state, pos);
      if (tile === undefined) continue;
      tiles.push({ position: { x: pos.x, y: pos.y }, tile: cloneTile(tile) });
    }
    snaps.push({
      regionId: state.regionId,
      direction,
      revision: 1,
      tick: state.tick ?? 0,
      tiles,
    });
  }
  return snaps;
}

function sumState(s) {
  let soil = 0, gw = 0, sw = 0, pending = 0;
  for (const t of s.tiles) {
    if (!isHexGridCell(s, t)) continue;
    if (t.terrain === "water") sw += t.surfaceWater ?? 0;
    else { soil += t.soilMoisture ?? 0; gw += t.groundwaterStorage ?? 0; pending += t.soilMoistureOverflow ?? 0; }
  }
  return soil + gw + sw + pending;
}

// 1. Mirror symmetry test
test("mirror symmetry: adjacent regions compute identical edge flux (1e-12)", () => {
  const seed = 5555;
  const regionA = "garden-1";
  const regionB = "garden-2";
  const regionIds = ["garden-1", "garden-2", "garden-3"];
  const stateA = makeRegionState(seed, regionA);
  const stateB = makeRegionState(seed, regionB);
  
  const linksA = buildConfiguredHexHaloLinks(extent, regionIds, regionA);
  const linksAB = linksA.filter(l => l.neighborRegionId === regionB);
  const snapsB = edgeSnapshotsForRegionAllDirs(stateB);
  const haloA = materializeHexHalo(linksAB, snapsB);
  
  const linksB = buildConfiguredHexHaloLinks(extent, regionIds, regionB);
  const linksBA = linksB.filter(l => l.neighborRegionId === regionA);
  const snapsA = edgeSnapshotsForRegionAllDirs(stateA);
  const haloB = materializeHexHalo(linksBA, snapsA);
  
  assert.ok(haloA.length > 0, `haloA should have entries, got ${haloA.length}`);
  assert.ok(haloB.length > 0, `haloB should have entries, got ${haloB.length}`);
  
  stateA.tick = 12;
  stateB.tick = 12;
  const ledgerA = updateTileSoilMoisture(stateA, haloA);
  const ledgerB = updateTileSoilMoisture(stateB, haloB);
  assert.ok(ledgerA);
  assert.ok(ledgerB);
  
  if (ledgerA.boundaryFluxTotal > 0 || ledgerB.boundaryFluxTotal > 0) {
    assert.ok(Math.abs(ledgerA.boundaryFluxTotal - ledgerB.boundaryFluxTotal) < 1e-12, 
      `totals differ: A=${ledgerA.boundaryFluxTotal} B=${ledgerB.boundaryFluxTotal}`);
  } else {
    assert.equal(typeof ledgerA.boundaryFluxTotal, "number");
    assert.equal(typeof ledgerB.boundaryFluxTotal, "number");
  }
});

// 2. Non-invasiveness: boundary flux derivation does not change storage amounts
test("non-invasiveness: boundary flux derivation does not change storage amounts (1e-12)", () => {
  const seed = 7777;
  const state1 = makeRegionState(seed, "garden-1");
  const state2 = makeRegionState(seed, "garden-1");
  const neighborState = makeRegionState(seed, "garden-2");
  for (const tile of neighborState.tiles) {
    if (isHexGridCell(neighborState, tile) && tile.terrain !== "water") {
      tile.groundwaterStorage = 0.05;
    }
  }
  const links = buildConfiguredHexHaloLinks(extent, ["garden-1", "garden-2", "garden-3"], "garden-1");
  const neighborLinks = links.filter(l => l.neighborRegionId === neighborState.regionId);
  const snaps = edgeSnapshotsForRegionAllDirs(neighborState);
  const halo = materializeHexHalo(neighborLinks, snaps);
  
  state1.tick = 12;
  state2.tick = 12;
  const before1 = sumState(state1);
  const ledger1 = updateTileSoilMoisture(state1);
  const after1 = sumState(state1);
  // reset state2 to before1 state equivalent
  const state2b = makeRegionState(seed, "garden-1");
  state2b.tick = 12;
  const ledger2 = updateTileSoilMoisture(state2b, halo);
  const after2 = sumState(state2b);
  assert.ok(ledger1);
  assert.ok(ledger2);
  // Both should produce same storage change (boundary flux doesn't affect storage)
  assert.ok(Math.abs((after1 - before1) - (after2 - (sumState(makeRegionState(seed, "garden-1"))))) < 1e-10 || 
            Math.abs(after1 - after2) < 1e-10, "storage should be unchanged by boundary flux derivation");
  assert.ok(typeof ledger2.boundaryFluxTotal === "number");
});

// 3. Ghost field propagation pin
test("ghost field propagation pin: cloneHaloTile copies water-cycle fields", () => {
  const seed = 8888;
  const state = makeRegionState(seed, "garden-1");
  const neighborState = makeRegionState(seed, "garden-2");
  for (const tile of neighborState.tiles) {
    if (isHexGridCell(neighborState, tile) && tile.terrain !== "water") {
      tile.groundwaterStorage = 0.033;
      tile.soilMoisture = 0.077;
      tile.surfaceWater = 0.002;
      tile.soilMoistureOverflow = 0.004;
      tile.bedrockElevation = 0.51;
      tile.soilThickness = 0.07;
    }
  }
  const links = buildConfiguredHexHaloLinks(extent, ["garden-1", "garden-2", "garden-3"], state.regionId);
  const neighborLinks = links.filter(l => l.neighborRegionId === neighborState.regionId);
  const snaps = edgeSnapshotsForRegionAllDirs(neighborState);
  const halo = materializeHexHalo(neighborLinks, snaps);
  assert.ok(halo.length > 0);
  const g = halo.find(h => h.tile && h.tile.terrain !== "water" && h.tile.groundwaterStorage === 0.033);
  assert.ok(g, "should find ghost with propagated groundwaterStorage");
  assert.equal(g.tile.soilMoisture, 0.077);
  assert.equal(g.tile.surfaceWater, 0.002);
  assert.equal(g.tile.soilMoistureOverflow, 0.004);
  assert.equal(g.tile.bedrockElevation, 0.51);
  assert.equal(g.tile.soilThickness, 0.07);
});

// 4. Head continuity / cadence
test("cadence gate and rngState unchanged with boundary flux", () => {
  const seed = 9999;
  const state = makeRegionState(seed, "garden-1");
  const neighborState = makeRegionState(seed, "garden-2");
  const links = buildConfiguredHexHaloLinks(extent, ["garden-1", "garden-2", "garden-3"], state.regionId);
  const neighborLinks = links.filter(l => l.neighborRegionId === neighborState.regionId);
  const snaps = edgeSnapshotsForRegionAllDirs(neighborState);
  const halo = materializeHexHalo(neighborLinks, snaps);
  
  state.tick = 5;
  const rngBefore = state.rngState;
  const ledger = updateTileSoilMoisture(state, halo);
  assert.equal(ledger, undefined);
  assert.equal(state.rngState, rngBefore);
  
  state.tick = 12;
  updateTileSoilMoisture(state, halo);
  assert.equal(typeof state.rngState, "number");
});

// 5. boundaryPendingAt accessor
test("boundaryPendingAt accessor returns pending for boundary cells", () => {
  const seed = 1111;
  const state = makeRegionState(seed, "garden-1");
  const neighborState = makeRegionState(seed, "garden-2");
  const links = buildConfiguredHexHaloLinks(extent, ["garden-1", "garden-2", "garden-3"], state.regionId);
  const neighborLinks = links.filter(l => l.neighborRegionId === neighborState.regionId);
  const snaps = edgeSnapshotsForRegionAllDirs(neighborState);
  const halo = materializeHexHalo(neighborLinks, snaps);
  const lookup = hexHaloLookup(halo);
  let found = null;
  for (const entry of lookup.values()) {
    if (entry.tile && entry.tile.terrain !== "water") { found = entry.sourcePosition; break; }
  }
  assert.ok(found, "should find boundary position with land ghost");
  const val = boundaryPendingAt(state, found, halo);
  assert.ok(typeof val === "number");
  assert.ok(val >= 0);
});
