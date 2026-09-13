import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function drainageTransitFixture({ drainage = 0.2, pathogen = 0.2, foodCapacity = 12 } = {}) {
  const state = createInitialWorld({ seed: 260914, width: 40, height: 24 });
  let localFood;
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    tile.drainage = drainage;
    tile.pathogenReservoir = pathogen;
    delete tile.resource;
    localFood ??= tile;
  }
  assert.ok(localFood);
  localFood.resource = { kind: "food", amount: 0, maxAmount: foodCapacity };

  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  state.agents = [builder];
  state.structures = [];
  state.tick = 26;
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
  return state;
}

function frontier({ drainage, pathogen, foodCapacity = 12 }) {
  return [{
    direction: "E",
    sourcePosition: { x: 30, y: 11 },
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: {
      x: 8,
      y: 11,
      terrain: "plain",
      elevation: 0.5,
      drainage,
      resource: { kind: "food", amount: 0, maxAmount: foodCapacity },
      ...(pathogen === undefined ? {} : { pathogenReservoir: pathogen }),
    },
  }];
}

test("transit pioneer continues along stronger durable food capacity with equal resource classes", () => {
  const state = drainageTransitFixture({ drainage: 0.2, pathogen: 0.2, foodCapacity: 12 });
  const plan = planAutonomousSettlementMigration(
    state,
    frontier({ drainage: 0.2, pathogen: 0.2, foodCapacity: 24 }),
  );

  assert.ok(plan);
  assert.equal(plan.direction, "E");
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
});

test("weaker durable food capacity cannot be overridden by cleaner or better-drained frontier", () => {
  const state = drainageTransitFixture({ drainage: 0.2, pathogen: 0.2, foodCapacity: 12 });
  const plan = planAutonomousSettlementMigration(
    state,
    frontier({ drainage: 1, pathogen: 0, foodCapacity: 6 }),
  );

  assert.equal(plan, undefined);
});

test("transit pioneer continues along better drainage when carrying capacity and pathogen burden tie", () => {
  const state = drainageTransitFixture({ drainage: 0.2, pathogen: 0.2 });
  const plan = planAutonomousSettlementMigration(
    state,
    frontier({ drainage: 0.8, pathogen: 0.2 }),
  );

  assert.ok(plan);
  assert.equal(plan.direction, "E");
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
});

test("better drainage cannot override a strictly dirtier equal-support frontier", () => {
  const state = drainageTransitFixture({ drainage: 0.2, pathogen: 0.2 });
  const plan = planAutonomousSettlementMigration(
    state,
    frontier({ drainage: 1, pathogen: 0.8 }),
  );

  assert.equal(plan, undefined);
});

test("missing pathogen metadata stays neutral while observed drainage may still improve", () => {
  const state = drainageTransitFixture({ drainage: 0.2, pathogen: 0.2 });
  const plan = planAutonomousSettlementMigration(
    state,
    frontier({ drainage: 0.8, pathogen: undefined }),
  );

  assert.ok(plan);
  assert.equal(plan.direction, "E");
});
