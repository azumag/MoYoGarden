import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function transitPioneerWithPreviousRegion() {
  const state = createInitialWorld({
    seed: 26091413,
    width: 40,
    height: 24,
    regionId: "garden-2",
  });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
  }
  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  builder.autonomy = true;
  builder.energy = 100;
  builder.position = { x: 19, y: 11 };
  builder.inventory = { ...BUILD_RECIPES.camp.cost };
  builder.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "build",
    structureType: "camp",
    settlementPreviousRegionId: "garden-1",
  };
  state.agents = [builder];
  state.structures = [];
  state.tick = 25;
  return state;
}

function foodHalo(direction, sourcePosition, neighborRegionId, neighborPosition, capacity) {
  return {
    direction,
    sourcePosition,
    neighborRegionId,
    neighborPosition,
    tile: {
      ...neighborPosition,
      terrain: "plain",
      elevation: 0.5,
      resource: { kind: "food", amount: 0, maxAmount: capacity },
    },
  };
}

test("transit pioneer does not immediately reverse into the previous axial region", () => {
  const state = transitPioneerWithPreviousRegion();
  const plan = planAutonomousSettlementMigration(state, [
    foodHalo("W", { x: 8, y: 11 }, "hex-q0-r0", { x: 30, y: 11 }, 100),
    foodHalo("E", { x: 30, y: 11 }, "hex-q2-r0", { x: 8, y: 11 }, 12),
  ]);

  assert.ok(plan);
  assert.equal(
    plan.neighborRegionId,
    "hex-q2-r0",
    "the canonical alias of garden-1 must be treated as the previous region even when it looks richer",
  );
});

test("transit pioneer settles instead of ping-ponging when only the previous region improves", () => {
  const state = transitPioneerWithPreviousRegion();
  const plan = planAutonomousSettlementMigration(state, [
    foodHalo("W", { x: 8, y: 11 }, "hex-q0-r0", { x: 30, y: 11 }, 100),
  ]);

  assert.equal(
    plan,
    undefined,
    "one-hop route memory should fail closed rather than immediately reversing the last handoff",
  );
});
