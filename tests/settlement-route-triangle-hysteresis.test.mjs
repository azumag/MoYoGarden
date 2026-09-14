import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function transitPioneerAtTriangleCorner() {
  const state = createInitialWorld({
    seed: 26091418,
    width: 40,
    height: 24,
    regionId: "garden-3",
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
    settlementPreviousRegionId: "garden-2",
  };
  state.agents = [builder];
  state.structures = [];
  state.tick = 31;
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

test("transit pioneer does not close the shortest three-region hex loop", () => {
  const state = transitPioneerAtTriangleCorner();
  const plan = planAutonomousSettlementMigration(state, [
    // garden-2 -> garden-3 -> garden-1 would close a three-region triangle.
    // The canonical alias deliberately looks much richer so support scoring
    // cannot accidentally hide a route-hysteresis regression.
    foodHalo("southWest", { x: 8, y: 22 }, "hex-q0-r0", { x: 30, y: 0 }, 100),
    // This frontier remains one step from the current region but is two hexes
    // away from the immediately previous region, so it keeps outward progress.
    foodHalo("northWest", { x: 19, y: 0 }, "hex-q1-r-2", { x: 19, y: 22 }, 12),
  ]);

  assert.ok(plan);
  assert.equal(
    plan.neighborRegionId,
    "hex-q1-r-2",
    "a richer frontier must not pull a pioneer around an immediate triangular cycle",
  );
});

test("transit pioneer settles when the only improving frontier closes a recent triangle", () => {
  const state = transitPioneerAtTriangleCorner();
  const plan = planAutonomousSettlementMigration(state, [
    foodHalo("southWest", { x: 8, y: 22 }, "garden-1", { x: 30, y: 0 }, 100),
  ]);

  assert.equal(
    plan,
    undefined,
    "bounded hysteresis should prefer settling over garden-2 -> garden-3 -> garden-1 oscillation",
  );
});
