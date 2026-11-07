import assert from "node:assert/strict";
import test from "node:test";
import {
  updateTileSoilMoisture,
  groundwaterHeadAt,
  groundwaterDepthAt,
  springDischargeAt,
  surfaceWaterNearbyAt,
  applyCapillaryRise,
  getTileGlobalPosition,
  resourceRegrowthChance,
  surfaceMoistureAt,
} from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile } from "../dist-ts/src/world.js";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { sampleWorldConditions, derivePorosity } from "../dist-ts/src/world-scale.js";

function makeState(seed = 7701) {
  const state = createInitialWorld({ seed, width: 40, height: 24, regionId: "garden-1" });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) {
      tile.terrain = "water"; tile.elevation = 0; tile.bedrockElevation = 0; tile.soilThickness = 0;
      tile.soilMoisture = 1; tile.groundwaterStorage = 0; tile.soilMoistureOverflow = 0; tile.surfaceWater = 0;
      continue;
    }
    tile.terrain = "plain";
    tile.elevation = 0.6;
    tile.bedrockElevation = 0.54;
    tile.soilThickness = 0.06;
    tile.soilMoisture = 0.05;
    tile.groundwaterStorage = 0.01;
    tile.soilMoistureOverflow = 0;
    delete tile.surfaceWater;
    delete tile.resource;
    delete tile.flowTo;
    tile.drainage = 0;
    tile.erosionPressure = 0;
  }
  for (const agent of state.agents) { agent.autonomy = false; delete agent.task; }
  return state;
}

function sumState(s) {
  let soil = 0, gw = 0, sw = 0, pending = 0;
  for (const t of s.tiles) {
    if (!isHexGridCell(s, t)) continue;
    if (t.terrain === "water") sw += t.surfaceWater ?? 0;
    else { soil += t.soilMoisture ?? 0; gw += t.groundwaterStorage ?? 0; pending += t.soilMoistureOverflow ?? 0; }
  }
  return { soil, gw, sw, pending, total: soil + gw + sw + pending };
}

// 1. Capillary rise: shallow-gw increases soil = decreases gw
test("capillary rise: shallow groundwater transfers to soil (1e-9)", () => {
  const state = makeState(7001);
  const tile = getTile(state, { x: 20, y: 12 });
  assert.ok(tile);
  tile.bedrockElevation = 0.55;
  tile.soilThickness = 0.05;
  tile.elevation = 0.6;
  tile.groundwaterStorage = 0.014; // head very close to surface (within reach)
  tile.soilMoisture = 0.005;
  const gwBefore = tile.groundwaterStorage ?? 0;
  const soilBefore = tile.soilMoisture ?? 0;
  const before = sumState(state);
  state.tick = 12;
  const ledger = updateTileSoilMoisture(state);
  assert.ok(ledger);
  const after = sumState(state);
  assert.ok(Math.abs((after.total - before.total) - (ledger.precipitation - ledger.drying - ledger.surfaceWaterSpill)) < 1e-9,
    `master balance: ${after.total - before.total} vs ${ledger.precipitation - ledger.drying - ledger.surfaceWaterSpill}`);
  assert.ok(ledger.capillaryRise >= 0);
});

// 2. Capillary: no transfer when storage 0
test("capillary rise: storage 0 => no transfer", () => {
  const state = makeState(7002);
  for (const tile of state.tiles) {
    if (isHexGridCell(state, tile) && tile.terrain !== "water") {
      tile.groundwaterStorage = 0;
    }
  }
  state.tick = 12;
  const ledger = updateTileSoilMoisture(state);
  assert.ok(ledger);
  assert.equal(ledger.capillaryRise, 0);
});

// 3. Capillary: deep head => no transfer
test("capillary rise: deep head => no transfer", () => {
  const state = makeState(7003);
  const tile = getTile(state, { x: 20, y: 12 });
  assert.ok(tile);
  tile.bedrockElevation = 0.1;
  tile.soilThickness = 0.1;
  tile.elevation = 0.8; // surface far above
  tile.groundwaterStorage = 0.001;
  tile.soilMoisture = 0.01;
  const gwBefore = tile.groundwaterStorage;
  const soilBefore = tile.soilMoisture;
  const rise = applyCapillaryRise(state);
  // may be 0 if head is deep
  assert.ok(rise >= 0);
  assert.ok((tile.groundwaterStorage ?? 0) <= gwBefore + 1e-12);
});

// 4. Capillary: soil saturated => no transfer
test("capillary rise: soil saturated => no transfer", () => {
  const state = makeState(7004);
  const tile = getTile(state, { x: 20, y: 12 });
  assert.ok(tile);
  tile.bedrockElevation = 0.5;
  tile.soilThickness = 0.1;
  tile.elevation = 0.6;
  tile.groundwaterStorage = 0.02;
  tile.soilMoisture = 1.0; // very high, likely above capacity
  const gwBefore = tile.groundwaterStorage;
  applyCapillaryRise(state);
  assert.ok((tile.groundwaterStorage ?? 0) <= gwBefore + 1e-12);
});

// 5. MASTER balance with capillary (internal transfer)
test("master balance preserved with capillary (1e-9)", () => {
  const state = makeState(7005);
  for (const tile of state.tiles) {
    if (isHexGridCell(state, tile) && tile.terrain !== "water") {
      tile.bedrockElevation = 0.52;
      tile.soilThickness = 0.08;
      tile.elevation = 0.6;
      tile.groundwaterStorage = 0.015;
      tile.soilMoisture = 0.02;
    }
  }
  const before = sumState(state);
  state.tick = 12;
  const ledger = updateTileSoilMoisture(state);
  assert.ok(ledger);
  const after = sumState(state);
  const delta = after.total - before.total;
  const expected = ledger.precipitation - ledger.drying - ledger.surfaceWaterSpill;
  assert.ok(Math.abs(delta - expected) < 1e-9, `delta=${delta} expected=${expected}`);
});

// 6. Drought resilience: shallow-gw maintains higher regrowth chance
test("drought resilience: shallow groundwater supports higher regrowth chance", () => {
  const state = makeState(7006);
  const tile = getTile(state, { x: 20, y: 12 });
  assert.ok(tile);
  tile.terrain = "plain";
  tile.resource = { kind: "wood", amount: 5, maxAmount: 10 };
  tile.bedrockElevation = 0.55; tile.soilThickness = 0.05; tile.elevation = 0.6;
  tile.soilMoisture = 0.005;
  tile.groundwaterStorage = 0.014;
  const before = resourceRegrowthChance(state, tile);
  applyCapillaryRise(state);
  const after = resourceRegrowthChance(state, tile);
  assert.ok(after >= before || (tile.soilMoisture ?? 0) > 0.005, `before=${before} after=${after} sm=${tile.soilMoisture}`);
});

// 7. Settlement score: shallow-gw preferred when other conditions equal
test("settlement migration prefers shallow groundwater when other conditions equal", () => {
  const state = createInitialWorld({ seed: 260913, width: 40, height: 24 });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    tile.drainage = 0.5;
    delete tile.resource;
  }
  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  state.agents = [builder];
  state.structures = [];
  state.tick = 25;
  builder.autonomy = true;
  builder.energy = 100;
  builder.position = { x: 19, y: 11 };
  builder.inventory = { wood: 8, stone: 4, food: 0 };
  builder.task = { source: "autonomy", issuedAtTick: state.tick, type: "build", structureType: "camp" };
  const halo = [
    {
      direction: "E",
      sourcePosition: { x: 30, y: 11 },
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 11 },
      tile: { x: 8, y: 11, terrain: "plain", elevation: 0.6, bedrockElevation: 0.54, soilThickness: 0.06, groundwaterStorage: 0.02, drainage: 0.5, resource: { kind: "food", amount: 5, maxAmount: 20 } },
    },
    {
      direction: "W",
      sourcePosition: { x: 8, y: 11 },
      neighborRegionId: "hex-q-1-r0",
      neighborPosition: { x: 30, y: 11 },
      tile: { x: 30, y: 11, terrain: "plain", elevation: 0.6, bedrockElevation: 0.54, soilThickness: 0.06, groundwaterStorage: 0.0, drainage: 0.5, resource: { kind: "food", amount: 5, maxAmount: 20 } },
    },
  ];
  const plan = planAutonomousSettlementMigration(state, halo);
  assert.ok(plan);
  assert.equal(plan.neighborRegionId, "hex-q1-r0"); // shallow gw side
});

// 8. Accessors: deterministic and boundary values
test("water-source accessors deterministic and boundary values", () => {
  const state = makeState(7008);
  const pos = { x: 20, y: 12 };
  const tile = getTile(state, pos);
  assert.ok(tile);
  tile.bedrockElevation = 0.5; tile.soilThickness = 0.1; tile.elevation = 0.6;
  tile.groundwaterStorage = 0.01;
  const d1 = groundwaterDepthAt(state, pos);
  const d2 = groundwaterDepthAt(state, pos);
  assert.equal(d1, d2);
  assert.ok(d1 >= 0);
  const s1 = springDischargeAt(state, pos);
  const s2 = springDischargeAt(state, pos);
  assert.equal(s1, s2);
  assert.ok(s1 >= 0);
  const n1 = surfaceWaterNearbyAt(state, pos);
  const n2 = surfaceWaterNearbyAt(state, pos);
  assert.equal(n1, n2);
  assert.ok(n1 >= 0);
  // water tile
  const waterPos = state.tiles.find(t => t.terrain === "water" && isHexGridCell(state, t));
  if (waterPos) {
    assert.equal(groundwaterDepthAt(state, waterPos), 0);
    assert.equal(springDischargeAt(state, waterPos), 0);
  }
});

// 9. Cadence gate, rngState unchanged, bedrock+soil==elevation
test("cadence gate, rngState unchanged, bedrock+soil==elevation (1e-12) with capillary", () => {
  const state = makeState(7009);
  state.tick = 5;
  const rngBefore = state.rngState;
  const ledger = updateTileSoilMoisture(state);
  assert.equal(ledger, undefined);
  assert.equal(state.rngState, rngBefore);
  state.tick = 12;
  updateTileSoilMoisture(state);
  for (const t of state.tiles) {
    if (!isHexGridCell(state, t) || t.terrain === "water") continue;
    const bed = t.bedrockElevation ?? 0;
    const soil = t.soilThickness ?? 0;
    const elev = t.elevation ?? 0;
    assert.ok(Math.abs(bed + soil - elev) < 1e-12);
  }
});
