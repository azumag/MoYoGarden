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
    tile.drainage = 0;
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

function equalResourceHalo() {
  return [
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
      sourcePosition: { x: 8, y: 11 },
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
  ];
}

test("pioneer prefers stronger observed land drainage when resource support is equal", () => {
  const { state, builder } = transitPioneerFixture();
  const halo = equalResourceHalo();
  halo[0].tile.drainage = 0.15;
  halo[1].tile.drainage = 0.8;

  const plan = planAutonomousSettlementMigration(state, halo);
  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});

test("partial legacy drainage metadata stays neutral instead of biasing migration", () => {
  const { state } = transitPioneerFixture();
  const baselineHalo = equalResourceHalo();
  const baseline = planAutonomousSettlementMigration(state, baselineHalo);
  assert.ok(baseline);

  const mixedHalo = equalResourceHalo();
  // Only one neighbor has migrated hydrology metadata. Unknown must not be
  // treated as dry, otherwise persisted legacy edges could change settlement
  // choice merely because they have not been backfilled yet.
  mixedHalo[0].tile.drainage = 1;
  const mixed = planAutonomousSettlementMigration(state, mixedHalo);
  assert.ok(mixed);
  assert.equal(mixed.neighborRegionId, baseline.neighborRegionId);
  assert.equal(mixed.direction, baseline.direction);
});
