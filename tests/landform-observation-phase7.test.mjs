import assert from "node:assert/strict";
import test from "node:test";
import {
  LANDFORM_THRESHOLDS,
  observeAlluvialFan,
  observeDelta,
  observeFloodplain,
  observeRiverIncision,
  terrainLandformAt,
} from "../dist-ts/src/landform-observation.js";
import { applyMassWasting, applyTerrainErosion } from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds } from "../dist-ts/src/world.js";

function allLandTiles(state) {
  return state.tiles.filter((t) => t.terrain !== "water" && inBounds(state, t));
}

test("1. pure function pin: observation does not mutate state", () => {
  const state = createInitialWorld({ seed: 7701, width: 16, height: 12, regionId: "garden-1" });
  const before = structuredClone(state);
  for (const tile of state.tiles) {
    if (!inBounds(state, tile)) continue;
    terrainLandformAt(state, tile);
    if (tile.terrain !== "water") {
      observeFloodplain(state, tile);
      observeAlluvialFan(state, tile);
      observeDelta(state, tile);
      observeRiverIncision(state, tile);
    }
  }
  assert.deepEqual(state, before);
});

test("2. determinism: same seed/state => same result, rngState unchanged", () => {
  const stateA = createInitialWorld({ seed: 7702, width: 16, height: 12, regionId: "garden-1" });
  const stateB = structuredClone(stateA);
  const rngBefore = stateA.rngState;
  const resultsA = [];
  const resultsB = [];
  for (const tile of stateA.tiles) {
    if (!inBounds(stateA, tile) || tile.terrain === "water") continue;
    resultsA.push([tile.x, tile.y, terrainLandformAt(stateA, tile)]);
  }
  for (const tile of stateB.tiles) {
    if (!inBounds(stateB, tile) || tile.terrain === "water") continue;
    resultsB.push([tile.x, tile.y, terrainLandformAt(stateB, tile)]);
  }
  assert.deepEqual(resultsA, resultsB);
  assert.equal(stateA.rngState, rngBefore);
});

test("3. water exclusion: water tiles return undefined/non-applicable", () => {
  const state = createInitialWorld({ seed: 7703, width: 16, height: 12, regionId: "garden-1" });
  let sawWater = false;
  for (const tile of state.tiles) {
    if (!inBounds(state, tile)) continue;
    if (tile.terrain === "water") {
      sawWater = true;
      assert.equal(terrainLandformAt(state, tile), undefined);
      assert.equal(observeFloodplain(state, tile).active, false);
      assert.equal(observeDelta(state, tile).active, false);
    } else {
      const v = terrainLandformAt(state, tile);
      assert.ok(v === undefined || ["floodplain", "alluvial-fan", "delta", "incised"].includes(v));
    }
  }
  // ensure test actually covered water handling (if none, create one)
  if (!sawWater) {
    const t = getTile(state, { x: 1, y: 1 });
    assert.ok(t); t.terrain = "water"; t.elevation = 0;
    assert.equal(terrainLandformAt(state, t), undefined);
  }
});

test("4. backward compatibility: existing plain/forest/hill/water states do not throw", () => {
  const state = createInitialWorld({ seed: 7704, width: 16, height: 12, regionId: "garden-1" });
  const terrains = ["plain", "forest", "hill", "water", "mountain"];
  for (let i = 0; i < state.tiles.length; i++) {
    if (!inBounds(state, state.tiles[i])) continue;
    state.tiles[i].terrain = terrains[i % terrains.length];
  }
  for (const tile of state.tiles) {
    if (!inBounds(state, tile)) continue;
    assert.doesNotThrow(() => terrainLandformAt(state, tile));
    if (tile.terrain !== "water") {
      assert.doesNotThrow(() => observeFloodplain(state, tile));
      assert.doesNotThrow(() => observeAlluvialFan(state, tile));
      assert.doesNotThrow(() => observeDelta(state, tile));
      assert.doesNotThrow(() => observeRiverIncision(state, tile));
    }
  }
});

test("5. observation pin after terrain events: deposition/incision conditions are observable", () => {
  const state = createInitialWorld({ seed: 7705, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of allLandTiles(state)) {
    tile.terrain = "plain";
    tile.bedrockElevation = 0.2; tile.soilThickness = 0.04; tile.elevation = 0.24;
    tile.drainage = 0; tile.erosionPressure = 0; delete tile.flowTo; delete tile.resource;
  }
  // steep upslope -> gentler foot with soil accumulation (fan-like depositional proxy)
  const upslope = getTile(state, { x: 5, y: 5 });
  const mid = getTile(state, { x: 6, y: 5 });
  const foot = getTile(state, { x: 7, y: 5 });
  assert.ok(upslope && mid && foot);
  upslope.bedrockElevation = 0.45; upslope.soilThickness = 0.02; upslope.elevation = 0.47; upslope.drainage = 0.6;
  mid.bedrockElevation = 0.30; mid.soilThickness = 0.03; mid.elevation = 0.33; mid.drainage = 0.7;
  foot.bedrockElevation = 0.18; foot.soilThickness = 0.055; foot.elevation = 0.235; foot.drainage = 0.7; // deposition accumulated
  const fanObs = observeAlluvialFan(state, foot);
  assert.ok(fanObs.strength >= 0, "fan observation returns a derived strength");
  assert.equal(typeof fanObs.active, "boolean");

  // water-adjacent low flat channel mouth (delta-like)
  const state2 = createInitialWorld({ seed: 7706, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of allLandTiles(state2)) {
    tile.terrain = "plain"; tile.bedrockElevation = 0.15; tile.soilThickness = 0.03; tile.elevation = 0.18;
    tile.drainage = 0; delete tile.resource;
  }
  const mouth = getTile(state2, { x: 6, y: 6 });
  const water = getTile(state2, { x: 7, y: 6 });
  assert.ok(mouth && water);
  water.terrain = "water"; water.elevation = 0; water.bedrockElevation = 0; water.soilThickness = 0;
  mouth.elevation = 0.08; mouth.bedrockElevation = 0.04; mouth.soilThickness = 0.04; mouth.drainage = 0.8; mouth.flowTo = { x: 7, y: 6 };
  const deltaObs = observeDelta(state2, mouth);
  assert.ok(deltaObs.strength > 0.3, `expected delta-like strength, got ${deltaObs.strength}`);
  // apply terrain events and ensure observation remains pure/valid
  applyTerrainErosion(state2);
  applyMassWasting(state2);
  assert.doesNotThrow(() => observeDelta(state2, mouth));
  assert.doesNotThrow(() => terrainLandformAt(state2, mouth));
});

test("6. existing invariants maintained: bedrock+soil==elevation (1e-12) and ledger conservation", () => {
  const state = createInitialWorld({ seed: 7707, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of allLandTiles(state)) { tile.terrain = "plain"; delete tile.resource; }
  const s = getTile(state, { x: 6, y: 6 });
  const t = getTile(state, { x: 7, y: 6 });
  if (s && t) { s.elevation = 0.5; s.soilThickness = 0.06; s.bedrockElevation = 0.44; t.elevation = 0.2; t.soilThickness = 0.02; t.bedrockElevation = 0.18; }
  const e = applyTerrainErosion(state);
  const m = applyMassWasting(state);
  for (const tile of allLandTiles(state)) terrainLandformAt(state, tile);
  if (e.removed + e.bedrockRemoved > 0) {
    assert.ok(Math.abs(e.removed + e.bedrockRemoved - (e.deposited + e.waterExport + e.clampLoss)) < 1e-9);
  }
  assert.ok(Math.abs(m.moved - (m.deposited + m.waterExport + m.clampLoss)) < 1e-9);
  for (const tile of allLandTiles(state)) {
    assert.ok(Math.abs((tile.bedrockElevation ?? 0) + (tile.soilThickness ?? 0) - (tile.elevation ?? 0)) < 1e-12);
  }
});

test("7. 7b handoff: enter/exit thresholds exported as named constants with gap >= 0.03", () => {
  const required = ["floodplain", "alluvialFan", "delta", "riverIncision"];
  for (const key of required) {
    const t = LANDFORM_THRESHOLDS[key];
    assert.ok(t, `missing threshold for ${key}`);
    assert.equal(typeof t.enter, "number");
    assert.equal(typeof t.exit, "number");
    assert.ok(t.enter > t.exit);
    assert.ok(t.enter - t.exit >= 0.03, `${key} gap ${t.enter - t.exit} < 0.03`);
    assert.ok(t.enter >= 0 && t.enter <= 1.5); // normalized strengths
    assert.ok(t.exit >= 0 && t.exit <= 1.5);
  }
});
