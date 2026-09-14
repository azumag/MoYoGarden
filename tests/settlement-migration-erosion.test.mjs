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
    tile.drainage = 0.1;
    tile.erosionPressure = 0.5;
    tile.resource = { kind: "food", amount: 5, maxAmount: 20 };
  }

  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  state.regionId = "hex-q0-r0";
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

function frontier(direction, regionId, sourcePosition, neighborPosition, erosionPressure) {
  return {
    direction,
    sourcePosition,
    neighborRegionId: regionId,
    neighborPosition,
    tile: {
      ...neighborPosition,
      terrain: "plain",
      elevation: 0.5,
      drainage: 0.1,
      erosionPressure,
      resource: { kind: "food", amount: 5, maxAmount: 20 },
    },
  };
}

test("transit pioneer continues toward lower erosion pressure when durable support ties", () => {
  const { state, builder } = transitPioneerFixture();
  const plan = planAutonomousSettlementMigration(state, [
    frontier("E", "hex-q1-r0", { x: 30, y: 11 }, { x: 8, y: 11 }, 0.2),
    frontier("W", "hex-q-1-r0", { x: 8, y: 11 }, { x: 30, y: 11 }, 0.1),
  ]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});

test("higher erosion pressure blocks continuation when all earlier support signals tie", () => {
  const { state } = transitPioneerFixture();
  const plan = planAutonomousSettlementMigration(state, [
    frontier("E", "hex-q1-r0", { x: 30, y: 11 }, { x: 8, y: 11 }, 0.8),
  ]);

  assert.equal(plan, undefined);
});
