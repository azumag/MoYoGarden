import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function transitPioneerFixture() {
  const state = createInitialWorld({ seed: 260914, width: 40, height: 24 });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
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
  builder.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "build",
    structureType: "camp",
  };
  return { state, builder };
}

function haloTile(
  direction,
  sourcePosition,
  neighborRegionId,
  neighborPosition,
  maxAmount,
  amount = 1,
  pathogenReservoir,
) {
  return {
    direction,
    sourcePosition,
    neighborRegionId,
    neighborPosition,
    tile: {
      ...neighborPosition,
      terrain: "plain",
      elevation: 0.5,
      ...(pathogenReservoir === undefined ? {} : { pathogenReservoir }),
      resource: { kind: "food", amount, maxAmount },
    },
  };
}

test("pioneer compares neighboring carrying capacity per sampled land cell", () => {
  const { state, builder } = transitPioneerFixture();
  const plan = planAutonomousSettlementMigration(state, [
    // East exposes more passable halo cells and therefore a larger raw maxAmount
    // total (20), but only 10 capacity per sampled land cell.
    haloTile("E", { x: 30, y: 11 }, "hex-q1-r0", { x: 8, y: 11 }, 10),
    haloTile("E", { x: 30, y: 10 }, "hex-q1-r0", { x: 8, y: 10 }, 10),
    // West exposes less land, but that land has the stronger sustainable density
    // (15). Observation footprint must not outweigh carrying-capacity quality.
    haloTile("W", { x: 8, y: 11 }, "hex-q-1-r0", { x: 30, y: 11 }, 15),
  ]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});

test("pioneer compares live resource supply per sampled land cell", () => {
  const { state, builder } = transitPioneerFixture();
  const plan = planAutonomousSettlementMigration(state, [
    // Equal sustainable density (10/cell), but East only has 6 live food/cell.
    // Its larger sampled edge makes the raw live total 12, which must not win.
    haloTile("E", { x: 30, y: 11 }, "hex-q1-r0", { x: 8, y: 11 }, 10, 6),
    haloTile("E", { x: 30, y: 10 }, "hex-q1-r0", { x: 8, y: 10 }, 10, 6),
    // West has the same carrying-capacity density and only one sampled cell,
    // but stronger immediately available food density (8/cell).
    haloTile("W", { x: 8, y: 11 }, "hex-q-1-r0", { x: 30, y: 11 }, 10, 8),
  ]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});

test("pioneer does not treat a larger halo sample as better settlement support", () => {
  const { state, builder } = transitPioneerFixture();
  const sharedSeam = { x: 30, y: 11 };
  const plan = planAutonomousSettlementMigration(state, [
    // Equal support quality and equal route cost isolate the support comparator.
    // East has fewer observed cells, so a raw sample-count tie-break would make
    // West win; without that bias the canonical direction order chooses east.
    haloTile("east", sharedSeam, "hex-q1-r0", { x: 8, y: 11 }, 10),
    haloTile("west", sharedSeam, "hex-q-1-r0", { x: 30, y: 11 }, 10),
    haloTile("west", sharedSeam, "hex-q-1-r0", { x: 30, y: 10 }, 10),
  ]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
  assert.equal(plan.direction, "east");
});

test("negligible carrying-capacity noise does not override pathogen risk", () => {
  const { state, builder } = transitPioneerFixture();
  const plan = planAutonomousSettlementMigration(state, [
    // A sub-epsilon capacity difference can arise from normalized samples and
    // must not dominate a materially worse pathogen reservoir.
    haloTile("E", { x: 30, y: 11 }, "hex-q1-r0", { x: 8, y: 11 }, 10.0000005, 1, 0.9),
    haloTile("W", { x: 8, y: 11 }, "hex-q-1-r0", { x: 30, y: 11 }, 10, 1, 0.1),
  ]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});

test("negligible live-supply noise does not override drainage quality", () => {
  const { state, builder } = transitPioneerFixture();
  const sharedSeam = { x: 30, y: 11 };
  const east = haloTile("east", sharedSeam, "hex-q1-r0", { x: 8, y: 11 }, 10, 5.0000005, 0.2);
  const west = haloTile("west", sharedSeam, "hex-q-1-r0", { x: 30, y: 11 }, 10, 5, 0.2);
  east.tile.drainage = 0.1;
  west.tile.drainage = 0.9;

  const plan = planAutonomousSettlementMigration(state, [east, west]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(
    plan.neighborRegionId,
    "hex-q-1-r0",
    "sub-epsilon live supply differences should not mask a materially better drainage sample",
  );
  assert.equal(plan.direction, "west");
});


test("pioneer uses whole-region carrying capacity when boundary samples are misleading", () => {
  const { state, builder } = transitPioneerFixture();
  const east = haloTile("E", { x: 30, y: 11 }, "hex-q1-r0", { x: 8, y: 11 }, 1, 1);
  east.neighborRegionSummary = {
    resources: { wood: 10, stone: 0, food: 20 },
    resourceCapacity: { wood: 20, stone: 0, food: 100 },
    passableCells: 100,
    occupants: 4,
  };
  const west = haloTile("W", { x: 8, y: 11 }, "hex-q-1-r0", { x: 30, y: 11 }, 20, 10);
  west.neighborRegionSummary = {
    resources: { wood: 10, stone: 0, food: 20 },
    resourceCapacity: { wood: 20, stone: 0, food: 50 },
    passableCells: 100,
    occupants: 4,
  };

  const plan = planAutonomousSettlementMigration(state, [east, west]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(
    plan.neighborRegionId,
    "hex-q1-r0",
    "interior carrying capacity should outweigh a richer-looking boundary cell",
  );
  assert.equal(plan.direction, "E");
});

test("rolling summaries without capacity keep boundary-based settlement scoring", () => {
  const { state, builder } = transitPioneerFixture();
  const east = haloTile("E", { x: 30, y: 11 }, "hex-q1-r0", { x: 8, y: 11 }, 5, 5);
  east.neighborRegionSummary = {
    resources: { wood: 0, stone: 0, food: 500 },
    passableCells: 397,
    occupants: 1,
  };
  const west = haloTile("W", { x: 8, y: 11 }, "hex-q-1-r0", { x: 30, y: 11 }, 10, 10);

  const plan = planAutonomousSettlementMigration(state, [east, west]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(
    plan.neighborRegionId,
    "hex-q-1-r0",
    "old summaries must not dilute boundary capacity by a whole-region denominator",
  );
  assert.equal(plan.direction, "W");
});

test("pioneer prefers the less populated region when ecological support ties", () => {
  const { state, builder } = transitPioneerFixture();
  // Make the transit region crowded enough that both neighboring
  // frontiers remain valid continuation choices. Extra residents are
  // non-autonomous and share the origin cell, so both routes see the
  // same local path cost and only regional density breaks the tie.
  for (let index = 0; index < 9; index += 1) {
    const resident = structuredClone(builder);
    resident.id = `resident-${index}`;
    resident.autonomy = false;
    delete resident.task;
    state.agents.push(resident);
  }

  const sharedSeam = { x: 30, y: 11 };
  const east = haloTile("E", sharedSeam, "hex-q1-r0", { x: 8, y: 11 }, 0, 0);
  east.neighborRegionSummary = {
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
    passableCells: 100,
    occupants: 2,
  };
  const west = haloTile("W", sharedSeam, "hex-q-1-r0", { x: 30, y: 11 }, 0, 0);
  west.neighborRegionSummary = {
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
    passableCells: 100,
    occupants: 1,
  };

  const plan = planAutonomousSettlementMigration(state, [east, west]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});

test("inconsistent rolling population summaries stay neutral for migration", () => {
  const { state, builder } = transitPioneerFixture();
  for (let index = 0; index < 9; index += 1) {
    const resident = structuredClone(builder);
    resident.id = `resident-${index}`;
    resident.autonomy = false;
    delete resident.task;
    state.agents.push(resident);
  }

  const sharedSeam = { x: 30, y: 11 };
  const eastA = haloTile("E", sharedSeam, "hex-q1-r0", { x: 8, y: 11 }, 0, 0);
  eastA.neighborRegionSummary = {
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
    passableCells: 100,
    occupants: 1,
  };
  const eastB = haloTile("E", sharedSeam, "hex-q1-r0", { x: 8, y: 10 }, 0, 0);
  eastB.neighborRegionSummary = {
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
    passableCells: 100,
    occupants: 99,
  };
  const west = haloTile("W", sharedSeam, "hex-q-1-r0", { x: 30, y: 11 }, 0, 0);
  west.neighborRegionSummary = {
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
    passableCells: 100,
    occupants: 2,
  };

  const plan = planAutonomousSettlementMigration(state, [eastA, eastB, west]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(
    plan.neighborRegionId,
    "hex-q-1-r0",
    "a mixed-tick east summary must not be trusted as a low-density whole-region observation",
  );
});


test("pioneer prefers less already-settled land when ecology and population tie", () => {
  const { state, builder } = transitPioneerFixture();
  for (let index = 0; index < 9; index += 1) {
    const resident = structuredClone(builder);
    resident.id = `resident-camp-${index}`;
    resident.autonomy = false;
    delete resident.task;
    state.agents.push(resident);
  }

  const sharedSeam = { x: 30, y: 11 };
  const east = haloTile("E", sharedSeam, "hex-q1-r0", { x: 8, y: 11 }, 0, 0);
  east.neighborRegionSummary = {
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
    activeStructures: { camp: 3, storehouse: 0, market: 0, workshop: 0 },
    passableCells: 100,
    occupants: 2,
  };
  const west = haloTile("W", sharedSeam, "hex-q-1-r0", { x: 30, y: 11 }, 0, 0);
  west.neighborRegionSummary = {
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
    activeStructures: { camp: 0, storehouse: 0, market: 0, workshop: 0 },
    passableCells: 100,
    occupants: 2,
  };

  const plan = planAutonomousSettlementMigration(state, [east, west]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});



test("pioneer prefers less developed frontier when camp and population density tie", () => {
  const { state, builder } = transitPioneerFixture();
  for (let index = 0; index < 9; index += 1) {
    const resident = structuredClone(builder);
    resident.id = `resident-structure-${index}`;
    resident.autonomy = false;
    delete resident.task;
    state.agents.push(resident);
  }

  const sharedSeam = { x: 30, y: 11 };
  const east = haloTile("E", sharedSeam, "hex-q1-r0", { x: 8, y: 11 }, 0, 0);
  east.neighborRegionSummary = {
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
    activeStructures: { camp: 0, storehouse: 1, market: 1, workshop: 1 },
    passableCells: 100,
    occupants: 2,
  };
  const west = haloTile("W", sharedSeam, "hex-q-1-r0", { x: 30, y: 11 }, 0, 0);
  west.neighborRegionSummary = {
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
    activeStructures: { camp: 0, storehouse: 0, market: 0, workshop: 0 },
    passableCells: 100,
    occupants: 2,
  };

  const plan = planAutonomousSettlementMigration(state, [east, west]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});
