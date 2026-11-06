import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { DEFAULT_SIMULATION_CONFIG } from "../dist-ts/src/protocol.js";
import {
  applySpringDischarge,
  getTileGlobalPosition,
  groundwaterHeadAt,
  simulate,
  updateTileSoilMoisture,
} from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile } from "../dist-ts/src/world.js";
import { derivePorosity, sampleWorldConditions } from "../dist-ts/src/world-scale.js";

function landFixture(seed = 9901) {
  const state = createInitialWorld({ seed, width: 40, height: 24, regionId: "garden-1" });
  for (const tile of state.tiles) {
    if (isHexGridCell(state, tile)) {
      tile.terrain = "plain";
      tile.elevation = 0.6;
      tile.bedrockElevation = 0.54;
      tile.soilThickness = 0.06;
      tile.soilMoisture = 0.02;
      tile.groundwaterStorage = 0;
      delete tile.resource;
      delete tile.flowTo;
      tile.drainage = 0;
      tile.erosionPressure = 0;
    } else {
      tile.terrain = "water";
      tile.elevation = 0;
      tile.bedrockElevation = 0;
      tile.soilThickness = 0;
    }
  }
  for (const agent of state.agents) {
    agent.autonomy = false;
    delete agent.task;
  }
  return state;
}

test("spring discharge emerges when groundwater head exceeds surface and conserves storage", () => {
  const state = landFixture(9901);
  // Force high groundwater storage so head > surface
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !isHexGridCell(state, tile)) continue;
    tile.groundwaterStorage = 0.05;
  }
  const beforeTotal = state.tiles.reduce((s, t) => s + (t.groundwaterStorage ?? 0), 0);
  const ledger = { springDischarge: 0, springDischargeByTile: new Map() };
  const discharged = applySpringDischarge(state, ledger);
  const afterTotal = state.tiles.reduce((s, t) => s + (t.groundwaterStorage ?? 0), 0);
  assert.ok(discharged > 0, `expected spring discharge > 0, got ${discharged}`);
  assert.ok(Math.abs(beforeTotal - afterTotal - discharged) < 1e-9,
    `conservation: before=${beforeTotal} after=${afterTotal} discharged=${discharged}`);
  assert.ok(Math.abs(ledger.springDischarge - discharged) < 1e-9);
  assert.ok(ledger.springDischargeByTile.size > 0);
});

test("spring discharge does not occur when head is below surface", () => {
  const state = landFixture(9902);
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !isHexGridCell(state, tile)) continue;
    tile.groundwaterStorage = 0.0001;
  }
  const ledger = { springDischarge: 0, springDischargeByTile: new Map() };
  const discharged = applySpringDischarge(state, ledger);
  assert.equal(discharged, 0);
  assert.equal(ledger.springDischargeByTile.size, 0);
});

test("spring discharge is bounded by available storage and keeps storage non-negative", () => {
  const state = landFixture(9903);
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !isHexGridCell(state, tile)) continue;
    tile.groundwaterStorage = 0.2; // very large
  }
  applySpringDischarge(state);
  for (const tile of state.tiles) {
    assert.ok((tile.groundwaterStorage ?? 0) >= -1e-12, `negative storage at ${tile.x},${tile.y}`);
  }
});

test("percolation calibration: groundwater accumulates and springs can emerge over time", () => {
  let s = createInitialWorld({ seed: 424242, width: 40, height: 24, regionId: "garden-1" });
  for (let i = 0; i < 1200; i++) s = simulate(s).state;
  const totalGW = s.tiles.reduce((sum, t) => sum + (t.groundwaterStorage ?? 0), 0);
  assert.ok(totalGW > 0, `expected groundwater accumulation, got ${totalGW}`);
  // Verify springs can form given accumulated storage (head exceeds surface somewhere)
  let springCells = 0;
  for (const t of s.tiles) {
    if (t.terrain === "water" || !isHexGridCell(s, t)) continue;
    if ((t.groundwaterStorage ?? 0) <= 0) continue;
    const head = groundwaterHeadAt(s, t);
    const surface = t.elevation ?? 0;
    if (head > surface) springCells++;
  }
  assert.ok(springCells > 0, `expected spring-forming conditions: springCells=${springCells} totalGW=${totalGW}`);
});

test("water balance step includes spring discharge in ledger and preserves invariants", () => {
  const state = landFixture(9905);
  // Seed groundwater
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !isHexGridCell(state, tile)) continue;
    tile.groundwaterStorage = 0.03;
  }
  state.tick = 12;
  const ledger = updateTileSoilMoisture(state);
  assert.ok(ledger !== undefined);
  assert.ok(typeof ledger.springDischarge === "number");
  assert.ok(ledger.springDischarge >= 0);
  assert.ok(ledger.springDischargeByTile instanceof Map);
  // bedrock + soil == elevation invariant still holds
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !isHexGridCell(state, tile)) continue;
    const bedrock = tile.bedrockElevation ?? 0;
    const soil = tile.soilThickness ?? 0;
    const elevation = tile.elevation ?? 0;
    assert.ok(Math.abs(bedrock + soil - elevation) < 1e-12,
      `invariant broken at (${tile.x},${tile.y})`);
  }
});
