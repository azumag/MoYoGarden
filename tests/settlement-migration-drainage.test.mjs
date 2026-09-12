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

test("pioneer prefers stronger observed land drainage when resource support is equal", () => {
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
        drainage: 0.15,
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
        drainage: 0.8,
        resource: { kind: "food", amount: 5, maxAmount: 20 },
      },
    },
  ];

  const plan = planAutonomousSettlementMigration(state, halo);
  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});

test("missing drainage metadata preserves the existing deterministic tie-break", () => {
  const { state } = transitPioneerFixture();
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

  const plan = planAutonomousSettlementMigration(state, halo);
  assert.ok(plan);
  // W is already the closer reachable seam from this fixture. With drainage
  // absent, the new hydrology tie-break must remain neutral and preserve that
  // existing distance-based result.
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});
