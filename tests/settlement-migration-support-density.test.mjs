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
