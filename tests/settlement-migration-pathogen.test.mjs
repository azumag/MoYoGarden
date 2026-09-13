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

function setLocalFoodCapacityDensity(state, maxAmount) {
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile) || tile.terrain === "water") continue;
    tile.resource = { kind: "food", amount: 0, maxAmount };
  }
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
  assert.equal(
    plan.direction,
    "W",
    "missing metadata must stay neutral so the normal deterministic tie-break remains authoritative",
  );
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
});

test("transit pioneer continues along a strictly cleaner equal-density pathogen gradient", () => {
  const { state } = transitPioneerFixture();
  setLocalFoodCapacityDensity(state, 12);
  const localFood = state.tiles.find((tile) => isHexGridCell(state, tile) && tile.terrain !== "water");
  assert.ok(localFood);
  localFood.pathogenReservoir = 0.9;

  const plan = planAutonomousSettlementMigration(state, [{
    direction: "E",
    sourcePosition: { x: 30, y: 11 },
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: {
      x: 8,
      y: 11,
      terrain: "plain",
      elevation: 0.5,
      resource: { kind: "food", amount: 0, maxAmount: 12 },
      pathogenReservoir: 0.1,
    },
  }]);

  assert.ok(plan);
  assert.equal(plan.direction, "E");
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
});

test("transit pioneer settles instead of moving toward a dirtier equal-density frontier", () => {
  const { state } = transitPioneerFixture();
  setLocalFoodCapacityDensity(state, 12);
  const localFood = state.tiles.find((tile) => isHexGridCell(state, tile) && tile.terrain !== "water");
  assert.ok(localFood);
  localFood.pathogenReservoir = 0.1;

  const plan = planAutonomousSettlementMigration(state, [{
    direction: "E",
    sourcePosition: { x: 30, y: 11 },
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: {
      x: 8,
      y: 11,
      terrain: "plain",
      elevation: 0.5,
      resource: { kind: "food", amount: 0, maxAmount: 12 },
      pathogenReservoir: 0.9,
    },
  }]);

  assert.equal(plan, undefined);
});
