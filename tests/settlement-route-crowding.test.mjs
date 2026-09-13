import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("pioneer prefers the less crowded shortest corridor when seam support and distance tie", () => {
  const state = createInitialWorld({ seed: 26091316, width: 40, height: 24 });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
  }
  state.structures = [];

  const builder = state.agents.find((agent) => agent.role === "builder");
  const blockers = state.agents.filter((agent) => agent.id !== builder?.id).slice(0, 2);
  assert.ok(builder);
  assert.equal(blockers.length, 2);

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
  for (const blocker of blockers) blocker.autonomy = false;
  blockers[0].position = { x: 29, y: 9 };
  blockers[1].position = { x: 29, y: 10 };
  state.agents = [builder, ...blockers];

  const crowdedCorridor = { x: 30, y: 9 };
  const quietCorridor = { x: 30, y: 11 };
  const halo = [
    {
      direction: "east",
      sourcePosition: crowdedCorridor,
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 9 },
      tile: {
        x: 8,
        y: 9,
        terrain: "plain",
        elevation: 0.5,
        resource: { kind: "food", amount: 4, maxAmount: 8 },
      },
    },
    {
      direction: "east",
      sourcePosition: quietCorridor,
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 11 },
      tile: {
        x: 8,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { kind: "food", amount: 4, maxAmount: 8 },
      },
    },
  ];

  const plan = planAutonomousSettlementMigration(state, halo);
  assert.ok(plan);
  assert.deepEqual(
    plan.boundaryTarget,
    quietCorridor,
    "equal-length pioneer routes should prefer the corridor with less accumulated BOT crowding",
  );
});