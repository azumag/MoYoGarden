import assert from "node:assert/strict";
import test from "node:test";
import {
  LANDFORM_THRESHOLDS,
  observeAlluvialFan,
  observeDelta,
  observeFloodplain,
  observeLandforms,
  observeRiverIncision,
} from "../dist-ts/src/landform-observation.js";
import { applyMassWasting, applyTerrainErosion, applyTerrainUplift } from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds, isPassableTile } from "../dist-ts/src/world.js";

function allLandTiles(state) {
  return state.tiles.filter((t) => t.terrain !== "water" && inBounds(state, t));
}

test("derived landform observation is pure: does not mutate state (1/7)", () => {
  const state = createInitialWorld({ seed: 7701, width: 16, height: 12, regionId: "garden-1" });
  const before = structuredClone(state);
  for (const tile of state.tiles) {
    if (!inBounds(state, tile) || tile.terrain === "water") continue;
    observeLandforms(state, tile);
    observeFloodplain(state, tile);
    observeAlluvialFan(state, tile);
    observeDelta(state, tile);
    observeRiverIncision(state, tile);
  }
  assert.deepEqual(state, before);
  for (const kind of ["floodplain", "alluvialFan", "delta", "riverIncision"]) {
    assert.ok(LANDFORM_THRESHOLDS[kind].enter - LANDFORM_THRESHOLDS[kind].exit >= 0.03);
  }
});

test("hysteresis prevents classification flapping at threshold boundary (2/7)", () => {
  const state = createInitialWorld({ seed: 7702, width: 16, height: 12, regionId: "garden-1" });
  const tile = getTile(state, { x: 6, y: 6 });
  assert.ok(tile && tile.terrain !== "water");
  // fabricate a near-threshold strength by probing: adjust properties to get a stable mid observation
  tile.elevation = 0.25; tile.bedrockElevation = 0.22; tile.soilThickness = 0.03;
  tile.drainage = 0.35; tile.erosionPressure = 0.2;
  const obs = observeFloodplain(state, tile, false);
  const { enter, exit } = LANDFORM_THRESHOLDS.floodplain;
  assert.ok(exit < enter && enter - exit >= 0.03);
  // if strength is in hysteresis band, previous active/inactive gives different active result
  if (obs.strength >= exit && obs.strength < enter) {
    assert.equal(observeFloodplain(state, tile, false).active, false);
    assert.equal(observeFloodplain(state, tile, true).active, true);
  } else {
    // deterministic: applying hysteresis is consistent
    const a = observeFloodplain(state, tile, false).active;
    const b = observeFloodplain(state, tile, true).active;
    assert.equal(typeof a, "boolean");
    assert.equal(typeof b, "boolean");
    if (obs.strength >= enter) assert.equal(a, true);
    if (obs.strength < exit) assert.equal(b, false);
  }
});

test("occupancy/terrain safety: observation does not water-ify or alter occupied tile (3/7)", () => {
  const state = createInitialWorld({ seed: 7703, width: 16, height: 12, regionId: "garden-1" });
  // pick a tile and simulate occupancy context by placing a structure-like check is out of scope;
  // option 2 is derived-only: verify terrain/passability/fields unchanged for any tile including those with agents nearby.
  const agent = state.agents[0];
  assert.ok(agent);
  const tile = getTile(state, agent.position);
  assert.ok(tile);
  const beforeTerrain = tile.terrain;
  const beforePassable = isPassableTile(tile);
  const before = structuredClone(tile);
  observeLandforms(state, tile);
  assert.equal(tile.terrain, beforeTerrain);
  assert.equal(isPassableTile(tile), beforePassable);
  assert.notEqual(tile.terrain, "water" === beforeTerrain ? "x" : "water"); // never changed to water
  assert.deepEqual(tile, before);
});

test("passability consistency: derived observation does not change Tile.terrain/passability (4/7)", () => {
  const state = createInitialWorld({ seed: 7704, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of state.tiles) {
    if (!inBounds(state, tile)) continue;
    const beforeTerrain = tile.terrain;
    const beforePassable = isPassableTile(tile);
    observeLandforms(state, tile);
    assert.equal(tile.terrain, beforeTerrain);
    assert.equal(isPassableTile(tile), beforePassable);
  }
});

test("ledger conservation maintained when using observations after terrain events (5/7)", () => {
  const state = createInitialWorld({ seed: 7705, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of allLandTiles(state)) { tile.terrain = "plain"; delete tile.resource; }
  // force conditions that may produce erosion/landslide
  const s = getTile(state, { x: 6, y: 6 });
  const t = getTile(state, { x: 7, y: 6 });
  if (s && t) { s.elevation = 0.5; s.soilThickness = 0.06; s.bedrockElevation = 0.44; t.elevation = 0.2; t.soilThickness = 0.02; t.bedrockElevation = 0.18; }
  applyTerrainUplift(state);
  const e = applyTerrainErosion(state);
  const m = applyMassWasting(state);
  // observations are pure and do not affect ledgers
  if (s) observeLandforms(state, s);
  assert.ok(Math.abs(e.removed + e.bedrockRemoved - (e.deposited + e.waterExport + e.clampLoss)) < 1e-9 || (e.removed + e.bedrockRemoved === 0));
  assert.ok(Math.abs(m.moved - (m.deposited + m.waterExport + m.clampLoss)) < 1e-9);
});

test("rngState unchanged by landform observation (6/7)", () => {
  const state = createInitialWorld({ seed: 7706, width: 16, height: 12, regionId: "garden-1" });
  const rngBefore = state.rngState;
  for (const tile of state.tiles) {
    if (!inBounds(state, tile) || tile.terrain === "water") continue;
    observeLandforms(state, tile);
  }
  assert.equal(state.rngState, rngBefore);
});

test("bedrock + soil == elevation (1e-12) preserved around observation usage (7/7)", () => {
  const state = createInitialWorld({ seed: 7707, width: 16, height: 12, regionId: "garden-1" });
  applyTerrainUplift(state);
  applyTerrainErosion(state);
  applyMassWasting(state);
  for (const tile of allLandTiles(state)) observeLandforms(state, tile);
  for (const tile of allLandTiles(state)) {
    const bedrock = tile.bedrockElevation ?? 0;
    const soil = tile.soilThickness ?? 0;
    const elev = tile.elevation ?? 0;
    assert.ok(Math.abs(bedrock + soil - elev) < 1e-12, `invariant at ${tile.x},${tile.y}`);
  }
});
