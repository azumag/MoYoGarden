import assert from "node:assert/strict";
import test from "node:test";
import { getTileGlobalPosition, groundwaterHeadAt, updateTileHydrology, updateTileSoilMoisture } from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds } from "../dist-ts/src/world.js";
import {
  derivePermeability,
  derivePorosity,
  precipitationAt,
  sampleWorldConditions,
} from "../dist-ts/src/world-scale.js";

function allLandTiles(state) {
  return state.tiles.filter((tile) => tile.terrain !== "water" && inBounds(state, tile));
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

test("groundwaterHeadAt = bedrockElevation + groundwaterStorage / effectivePorosity (1e-12)", () => {
  const state = createInitialWorld({ seed: 2501, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of allLandTiles(state)) tile.terrain = "plain";
  updateTileHydrology(state);
  let checked = 0;
  for (const tile of allLandTiles(state)) {
    tile.groundwaterStorage = 0.02;
    tile.soilMoisture = 0.03;
    tile.bedrockElevation = 0.2;
    tile.soilThickness = 0.1;
    tile.elevation = 0.3;
    const head = groundwaterHeadAt(state, tile);
        const { globalX, globalY } = getTileGlobalPosition(state, tile);
    const conditions = sampleWorldConditions(state.seed, globalX, globalY);
    const porosity = derivePorosity(state.seed, globalX, globalY, conditions.elevation);
    const expected = 0.2 + 0.02 / Math.max(1e-6, porosity);
    assert.ok(Math.abs(head - expected) < 1e-12, `${head} vs ${expected}`);
    // soilMoisture must NOT drive head in corrected model
    tile.soilMoisture = 0.09;
    const afterSoil = groundwaterHeadAt(state, tile);
    assert.ok(Math.abs(afterSoil - expected) < 1e-12);
    checked += 1;
  }
  assert.ok(checked > 0);
});

test("groundwaterStorage has lazy init and head is non-persistent derived", () => {
  const state = createInitialWorld({ seed: 2502, width: 16, height: 12, regionId: "garden-1" });
  updateTileHydrology(state);
  state.tick = 12;
  updateTileSoilMoisture(state);
  for (const tile of allLandTiles(state)) {
    assert.ok(Number.isFinite(tile.groundwaterStorage ?? 0));
    assert.ok((tile.groundwaterStorage ?? 0) >= -1e-12);
    assert.equal(Object.prototype.hasOwnProperty.call(tile, "groundwaterHead"), false);
  }
});

test("strict water balance per step: infiltration-drying = ΔsoilMoisture + overflow + percolation (1e-9)", () => {
  const state = createInitialWorld({ seed: 2503, width: 16, height: 12, regionId: "garden-1" });
  updateTileHydrology(state);
  // set explicit moisture/storage to avoid lazy-init ambiguity
  for (const tile of allLandTiles(state)) {
    tile.soilMoisture = Math.max(0, (tile.soilMoisture ?? 0.02));
    tile.groundwaterStorage = 0;
  }
  state.tick = 12;
  const before = new Map();
  for (const tile of allLandTiles(state)) {
    before.set(`${tile.x},${tile.y}`, { soil: tile.soilMoisture ?? 0, gw: tile.groundwaterStorage ?? 0 });
  }
  updateTileSoilMoisture(state);

  for (const tile of allLandTiles(state)) {
    const k = `${tile.x},${tile.y}`;
    const b = before.get(k);
    const soilAfter = tile.soilMoisture ?? 0;
    const gwAfter = tile.groundwaterStorage ?? 0;
    const overflow = tile.soilMoistureOverflow ?? 0;
    const percolation = gwAfter - b.gw; // no gw outflow in Phase 2
    assert.ok(percolation >= -1e-12);

    // recompute infiltration-drying using same formulas/inputs as implementation
    const seed = state.seed;
    const tick = 12;
    const { globalX: gx, globalY: gy } = getTileGlobalPosition(state, tile);
    const conditions = sampleWorldConditions(seed, gx, gy);
    const permeability = derivePermeability(seed, gx, gy, conditions.elevation, conditions.slope);
    const porosity = derivePorosity(seed, gx, gy, conditions.elevation);
    const soilThickness = Math.max(0, tile.soilThickness ?? 0.01);
    const capacity = Math.max(0.01, Math.min(0.5, porosity * (0.6 + soilThickness * 1.8)));
    const currentMoisture = b.soil;
    const precip = precipitationAt(seed, gx, gy, tick) * 12; // WATER_BALANCE_INTERVAL
    const infiltration = precip * permeability * (1 - clamp01(currentMoisture / Math.max(1e-6, capacity)));
    const equilibriumFrac = clamp01(0.15 + conditions.wetness * 0.35 + (1 - conditions.slope) * 0.1 - conditions.temperature * 0.08);
    const equilibrium = equilibriumFrac * capacity;
    const dryingRate = 0.06 + (1 - conditions.wetness) * 0.04;
    const drying = (currentMoisture - equilibrium) * dryingRate;

    const identity = (soilAfter - currentMoisture) + overflow + percolation;
    assert.ok(Math.abs(identity - (infiltration - drying)) < 1e-9,
      `balance mismatch at ${k}: ${identity} vs ${infiltration - drying} (inf=${infiltration} dry=${drying} dSoil=${soilAfter-currentMoisture} ov=${overflow} perc=${percolation})`);
  }
});

test("storage <= pore cap and cap reached => percolation bounded to zero at cap", () => {
  const state = createInitialWorld({ seed: 2504, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of allLandTiles(state)) tile.terrain = "plain";
  updateTileHydrology(state);
  const tile = getTile(state, { x: 6, y: 6 });
  assert.ok(tile && tile.terrain !== "water");
  tile.bedrockElevation = 0.2;
  tile.soilThickness = 0.1;
  tile.elevation = 0.3;
  tile.soilMoisture = 0.2;
  const { globalX, globalY } = getTileGlobalPosition(state, tile);
  const conditions = sampleWorldConditions(state.seed, globalX, globalY);
  const porosity = derivePorosity(state.seed, globalX, globalY, conditions.elevation);
  const maxStorage = Math.max(0, porosity * Math.max(0, 0.3 - 0.2));
  tile.groundwaterStorage = maxStorage; // at cap
  state.tick = 12;
  updateTileSoilMoisture(state);
  assert.ok((tile.groundwaterStorage ?? 0) <= maxStorage + 1e-12);
  assert.ok(Math.abs((tile.groundwaterStorage ?? 0) - maxStorage) < 1e-9, `should stay at cap: ${tile.groundwaterStorage} vs ${maxStorage}`);
});

test("higher permeability produces larger percolation", () => {
  const state = createInitialWorld({ seed: 2505, width: 16, height: 12, regionId: "garden-1" });
  for (const tile of allLandTiles(state)) tile.terrain = "plain";
  updateTileHydrology(state);
  let hi = null, lo = null;
  for (const tile of allLandTiles(state)) {
    const { globalX, globalY } = getTileGlobalPosition(state, tile);
    const c = sampleWorldConditions(state.seed, globalX, globalY);
    const p = derivePermeability(state.seed, globalX, globalY, c.elevation, c.slope);
    if (hi === null || p > hi.p) hi = { tile, p, c, globalX, globalY };
    if (lo === null || p < lo.p) lo = { tile, p, c, globalX, globalY };
  }
  assert.ok(hi && lo && hi.p > lo.p + 1e-6);
  const setup = ({ tile, globalX, globalY, c }) => {
    tile.bedrockElevation = 0.1; tile.soilThickness = 0.2; tile.elevation = 0.3;
    tile.groundwaterStorage = 0;
    const porosity = derivePorosity(state.seed, globalX, globalY, c.elevation);
    const capacity = Math.max(0.01, Math.min(0.5, porosity * (0.6 + 0.2 * 1.8)));
    const fieldCapacity = capacity * 0.6;
    tile.soilMoisture = Math.min(capacity - 1e-6, fieldCapacity + 0.02); // controlled excess
    return { fieldCapacity };
  };
  setup(hi); setup(lo);
  state.tick = 12;
  updateTileSoilMoisture(state);
  assert.ok((hi.tile.groundwaterStorage ?? 0) > (lo.tile.groundwaterStorage ?? 0) + 1e-12,
    `higher permeability should percolate more: hi=${hi.p}->${hi.tile.groundwaterStorage}, lo=${lo.p}->${lo.tile.groundwaterStorage}`);
});

test("bedrock + soil == elevation remains valid (1e-12) after water balance with groundwater", () => {
  const state = createInitialWorld({ seed: 2506, width: 16, height: 12, regionId: "garden-1" });
  updateTileHydrology(state);
  for (let tick = 12; tick <= 120; tick += 12) {
    state.tick = tick;
    updateTileSoilMoisture(state);
  }
  for (const tile of allLandTiles(state)) {
    const bedrock = tile.bedrockElevation ?? 0;
    const soil = tile.soilThickness ?? 0;
    const elev = tile.elevation ?? 0;
    assert.ok(Math.abs(bedrock + soil - elev) < 1e-12);
  }
});
