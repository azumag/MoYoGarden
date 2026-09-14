import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
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

test("pioneer prefers equally resourced neighboring support with visible surface water", () => {
  const { state, builder } = transitPioneerFixture();
  const halo = [
    {
      direction: "E",
      sourcePosition: { x: 30, y: 11 },
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 11 },
      tile: {
        x: 8,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { kind: "food", amount: 5, maxAmount: 20 },
      },
    },
    {
      direction: "W",
      sourcePosition: { x: 30, y: 11 },
      neighborRegionId: "hex-q-1-r0",
      neighborPosition: { x: 30, y: 11 },
      tile: {
        x: 30,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { kind: "food", amount: 5, maxAmount: 20 },
      },
    },
    {
      direction: "W",
      sourcePosition: { x: 29, y: 10 },
      neighborRegionId: "hex-q-1-r0",
      neighborPosition: { x: 29, y: 10 },
      tile: {
        x: 29,
        y: 10,
        terrain: "water",
        elevation: 0.25,
      },
    },
  ];

  const plan = planAutonomousSettlementMigration(state, halo);
  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});

test("transit pioneer continues toward visible water when renewable support is otherwise equal", () => {
  const { state, builder } = transitPioneerFixture();
  const localFood = state.tiles.find((tile) => tile.x === 19 && tile.y === 11);
  assert.ok(localFood);
  assert.equal(isHexGridCell(state, localFood), true);
  localFood.resource = { kind: "food", amount: 5, maxAmount: 20 };

  const halo = [
    {
      direction: "E",
      sourcePosition: { x: 30, y: 11 },
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 11 },
      tile: {
        x: 8,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { kind: "food", amount: 5, maxAmount: 20 },
      },
    },
    {
      direction: "E",
      sourcePosition: { x: 29, y: 10 },
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 9, y: 10 },
      tile: {
        x: 9,
        y: 10,
        terrain: "water",
        elevation: 0.25,
      },
    },
  ];

  const plan = planAutonomousSettlementMigration(state, halo);
  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
  assert.equal(plan.direction, "E");
});

test("transit pioneer does not give up a renewable food class just for visible water", () => {
  const { state } = transitPioneerFixture();
  const localFood = state.tiles.find((tile) => tile.x === 19 && tile.y === 11);
  assert.ok(localFood);
  localFood.resource = { kind: "food", amount: 1, maxAmount: 20 };

  const plan = planAutonomousSettlementMigration(state, [
    {
      direction: "E",
      sourcePosition: { x: 30, y: 11 },
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 11 },
      tile: {
        x: 8,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { kind: "wood", amount: 5, maxAmount: 20 },
      },
    },
    {
      direction: "E",
      sourcePosition: { x: 29, y: 10 },
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 9, y: 10 },
      tile: {
        x: 9,
        y: 10,
        terrain: "plain",
        elevation: 0.5,
        resource: { kind: "stone", amount: 5, maxAmount: 20 },
      },
    },
    {
      direction: "E",
      sourcePosition: { x: 28, y: 9 },
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 10, y: 9 },
      tile: {
        x: 10,
        y: 9,
        terrain: "water",
        elevation: 0.25,
      },
    },
  ]);

  assert.equal(plan, undefined);
});

test("surface water alone never becomes a passable migration handoff candidate", () => {
  const { state } = transitPioneerFixture();
  const plan = planAutonomousSettlementMigration(state, [{
    direction: "E",
    sourcePosition: { x: 30, y: 11 },
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: {
      x: 8,
      y: 11,
      terrain: "water",
      elevation: 0.25,
    },
  }]);

  assert.equal(plan, undefined);
});

test("migration compares surface water by observed-cell fraction instead of raw sample count", () => {
  const { state, builder } = transitPioneerFixture();
  const food = (direction, sourcePosition, neighborRegionId, neighborPosition) => ({
    direction,
    sourcePosition,
    neighborRegionId,
    neighborPosition,
    tile: {
      ...neighborPosition,
      terrain: "plain",
      elevation: 0.5,
      resource: { kind: "food", amount: 5, maxAmount: 20 },
    },
  });
  const water = (direction, sourcePosition, neighborRegionId, neighborPosition) => ({
    direction,
    sourcePosition,
    neighborRegionId,
    neighborPosition,
    tile: {
      ...neighborPosition,
      terrain: "water",
      elevation: 0.25,
    },
  });

  const halo = [
    food("E", { x: 30, y: 11 }, "hex-q1-r0", { x: 8, y: 11 }),
    water("E", { x: 29, y: 10 }, "hex-q1-r0", { x: 9, y: 10 }),
    food("W", { x: 8, y: 11 }, "hex-q-1-r0", { x: 30, y: 11 }),
    food("W", { x: 9, y: 10 }, "hex-q-1-r0", { x: 29, y: 10 }),
    food("W", { x: 9, y: 11 }, "hex-q-1-r0", { x: 29, y: 11 }),
    food("W", { x: 9, y: 12 }, "hex-q-1-r0", { x: 29, y: 12 }),
    water("W", { x: 10, y: 9 }, "hex-q-1-r0", { x: 28, y: 9 }),
    water("W", { x: 10, y: 13 }, "hex-q-1-r0", { x: 28, y: 13 }),
  ];

  const plan = planAutonomousSettlementMigration(state, halo);
  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(
    plan.neighborRegionId,
    "hex-q1-r0",
    "one water cell among two observed cells should outrank two water cells among six equally supported cells",
  );
});

test("transit pioneer compares local and neighboring water exposure by observed-cell fraction", () => {
  const { state, builder } = transitPioneerFixture();
  let localWater;
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    tile.resource = { kind: "food", amount: 0, maxAmount: 20 };
    if (localWater === undefined && (tile.x !== builder.position.x || tile.y !== builder.position.y)) {
      localWater = tile;
    }
  }
  assert.ok(localWater);
  localWater.terrain = "water";
  delete localWater.resource;

  const plan = planAutonomousSettlementMigration(state, [
    {
      direction: "E",
      sourcePosition: { x: 30, y: 11 },
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 11 },
      tile: {
        x: 8,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { kind: "food", amount: 0, maxAmount: 20 },
      },
    },
    {
      direction: "E",
      sourcePosition: { x: 29, y: 10 },
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 9, y: 10 },
      tile: {
        x: 9,
        y: 10,
        terrain: "water",
        elevation: 0.25,
      },
    },
  ]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
});
