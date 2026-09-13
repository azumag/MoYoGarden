import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function transitPioneerFixture() {
  const state = createInitialWorld({ seed: 260913, width: 40, height: 24 });
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
  builder.capacity = 100;
  builder.position = { x: 19, y: 11 };
  builder.inventory = { ...BUILD_RECIPES.camp.cost };
  builder.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "build",
    structureType: "camp",
  };
  return { state, builder };
}

test("pioneer prefers the cleaner frontier when carrying capacity is equal", () => {
  const { state } = transitPioneerFixture();
  const sharedSeam = { x: 30, y: 11 };
  const food = { kind: "food", amount: 8, maxAmount: 12 };
  const plan = planAutonomousSettlementMigration(state, [
    {
      direction: "E",
      sourcePosition: sharedSeam,
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 11 },
      tile: {
        x: 8,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { ...food },
        pathogenReservoir: 0.9,
      },
    },
    {
      direction: "W",
      sourcePosition: sharedSeam,
      neighborRegionId: "hex-q-1-r0",
      neighborPosition: { x: 30, y: 11 },
      tile: {
        x: 30,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { ...food },
        pathogenReservoir: 0.1,
      },
    },
  ]);

  assert.ok(plan);
  assert.equal(plan.direction, "W");
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
});

test("missing pathogen metadata stays neutral during rolling compatibility", () => {
  const { state } = transitPioneerFixture();
  const sharedSeam = { x: 30, y: 11 };
  const food = { kind: "food", amount: 8, maxAmount: 12 };
  const plan = planAutonomousSettlementMigration(state, [
    {
      direction: "E",
      sourcePosition: sharedSeam,
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 11 },
      tile: {
        x: 8,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { ...food },
      },
    },
    {
      direction: "W",
      sourcePosition: sharedSeam,
      neighborRegionId: "hex-q-1-r0",
      neighborPosition: { x: 30, y: 11 },
      tile: {
        x: 30,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { ...food },
        pathogenReservoir: 0.1,
      },
    },
  ]);

  assert.ok(plan);
  assert.equal(plan.direction, "E", "missing metadata must not be treated as cleaner than an explicit sample");
});
