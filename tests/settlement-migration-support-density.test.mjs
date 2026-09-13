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

function haloTile(direction, sourcePosition, neighborRegionId, neighborPosition, maxAmount) {
  return {
    direction,
    sourcePosition,
    neighborRegionId,
    neighborPosition,
    tile: {
      ...neighborPosition,
      terrain: "plain",
      elevation: 0.5,
      resource: { kind: "food", amount: 1, maxAmount },
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
