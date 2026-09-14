import assert from "node:assert/strict";
import test from "node:test";
import { hexGridDistance, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function transitBuilderFixture(seed = 26091316) {
  const state = createInitialWorld({ seed, width: 40, height: 24 });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
  }
  state.structures = [];

  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  builder.autonomy = true;
  builder.energy = 100;
  builder.inventory = { wood: 8, stone: 4, food: 0 };
  builder.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "build",
    structureType: "camp",
  };
  return { state, builder };
}

function eastHalo(crowdedCorridor, quietCorridor) {
  return [
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
}

test("pioneer prefers the less crowded shortest corridor when seam support and distance tie", () => {
  const { state, builder } = transitBuilderFixture();
  builder.position = { x: 19, y: 11 };

  const blockers = state.agents.filter((agent) => agent.id !== builder.id).slice(0, 2);
  assert.equal(blockers.length, 2);
  for (const blocker of blockers) blocker.autonomy = false;
  blockers[0].position = { x: 29, y: 9 };
  blockers[1].position = { x: 29, y: 10 };
  state.agents = [builder, ...blockers];

  const crowdedCorridor = { x: 30, y: 9 };
  const quietCorridor = { x: 30, y: 11 };
  const plan = planAutonomousSettlementMigration(
    state,
    eastHalo(crowdedCorridor, quietCorridor),
  );
  assert.ok(plan);
  assert.deepEqual(
    plan.boundaryTarget,
    quietCorridor,
    "equal-length pioneer routes should prefer the corridor with less accumulated BOT crowding",
  );
});

test("pioneer accepts one extra step to avoid a heavily crowded settlement seam", () => {
  const { state, builder } = transitBuilderFixture(26091409);
  builder.position = { x: 19, y: 10 };

  const crowdedCorridor = { x: 30, y: 9 };
  const quietCorridor = { x: 30, y: 11 };
  assert.equal(
    hexGridDistance(builder.position, quietCorridor),
    hexGridDistance(builder.position, crowdedCorridor) + 1,
    "fixture should make the quiet seam exactly one geometric step farther",
  );

  const blockers = state.agents.filter((agent) => agent.id !== builder.id).slice(0, 3);
  assert.equal(blockers.length, 3);
  for (const blocker of blockers) {
    blocker.autonomy = false;
    blocker.position = { ...crowdedCorridor };
  }
  state.agents = [builder, ...blockers];

  const plan = planAutonomousSettlementMigration(
    state,
    eastHalo(crowdedCorridor, quietCorridor),
  );
  assert.ok(plan);
  assert.deepEqual(
    plan.boundaryTarget,
    quietCorridor,
    "three occupied seam slots should cost more than one extra step of pioneer travel",
  );
});
