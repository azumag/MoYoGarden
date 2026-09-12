import assert from "node:assert/strict";
import test from "node:test";
import { hexGridDistance, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import {
  planAutonomousSettlementMigration,
  prepareSettlementMigrationKit,
  settlementMigrationPressure,
} from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function fixture() {
  const state = createInitialWorld({ seed: 260912, width: 40, height: 24 });
  for (const tile of state.tiles) {
    if (isHexGridCell(state, tile)) {
      tile.terrain = "plain";
      delete tile.resource;
    }
  }
  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  const faction = state.factions.find((entry) => entry.id === builder.factionId);
  assert.ok(faction);
  const sameFaction = [builder, ...state.agents.filter((agent) => agent.id !== builder.id).slice(0, 6)];
  for (const agent of sameFaction) {
    agent.factionId = builder.factionId;
    agent.autonomy = agent.id === builder.id;
    agent.energy = 100;
    delete agent.task;
  }
  state.agents = sameFaction;
  builder.position = { x: 19, y: 11 };
  builder.inventory = { wood: 0, stone: 0, food: 0 };
  builder.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "build",
    structureType: "camp",
    target: { x: 20, y: 11 },
  };
  faction.resources = { wood: 40, stone: 30, food: 20 };

  const camp = {
    id: "home-camp",
    factionId: builder.factionId,
    type: "camp",
    position: { x: 19, y: 11 },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  };
  const blockers = state.tiles
    .filter((tile) =>
      isHexGridCell(state, tile)
      && tile.terrain !== "water"
      && hexGridDistance(tile, camp.position) <= 5
      && hexGridDistance(tile, camp.position) >= 2
    )
    .map((tile, index) => ({
      id: `occupied-${index}`,
      factionId: builder.factionId,
      type: "workshop",
      position: { x: tile.x, y: tile.y },
      status: "active",
      progress: 13,
      requiredProgress: 13,
      storage: { wood: 0, stone: 0, food: 0 },
    }));
  state.structures = [camp, ...blockers];
  state.tick = 24;
  return { state, builder, faction, blockers };
}

function eastHalo() {
  return [{
    direction: "E",
    sourcePosition: { x: 30, y: 11 },
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 },
  }];
}

test("population pressure with no spaced local camp site plans a neighboring pioneer", () => {
  const { state, builder } = fixture();
  assert.equal(settlementMigrationPressure(state, builder.factionId), true);
  const plan = planAutonomousSettlementMigration(state, eastHalo());
  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.direction, "E");
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
  assert.deepEqual(plan.boundaryTarget, { x: 30, y: 11 });
});

test("pioneer prefers a resource-supported neighboring edge at equal travel cost", () => {
  const { state } = fixture();
  const sharedSeam = { x: 30, y: 11 };
  const plan = planAutonomousSettlementMigration(state, [
    {
      direction: "E",
      sourcePosition: sharedSeam,
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 11 },
      tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 },
    },
    {
      direction: "W",
      sourcePosition: sharedSeam,
      neighborRegionId: "hex-q-1-r0",
      neighborPosition: { x: 30, y: 11 },
      tile: {
        x: 30,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { kind: "food", amount: 8, maxAmount: 8 },
      },
    },
  ]);

  assert.ok(plan);
  assert.equal(plan.direction, "W");
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.deepEqual(plan.boundaryTarget, sharedSeam);
});

test("duplicate halo references do not inflate one neighbor's visible support", () => {
  const { state } = fixture();
  const sharedSeam = { x: 30, y: 11 };
  const duplicatedEast = {
    direction: "E",
    sourcePosition: sharedSeam,
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: {
      x: 8,
      y: 11,
      terrain: "plain",
      elevation: 0.5,
      resource: { kind: "food", amount: 5, maxAmount: 5 },
    },
  };
  const plan = planAutonomousSettlementMigration(state, [
    duplicatedEast,
    { ...duplicatedEast, sourcePosition: { ...sharedSeam } },
    {
      direction: "W",
      sourcePosition: sharedSeam,
      neighborRegionId: "hex-q-1-r0",
      neighborPosition: { x: 30, y: 11 },
      tile: {
        x: 30,
        y: 11,
        terrain: "plain",
        elevation: 0.5,
        resource: { kind: "food", amount: 6, maxAmount: 6 },
      },
    },
  ]);

  assert.ok(plan);
  assert.equal(plan.direction, "W");
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
});

test("a viable spaced local camp site keeps growth local", () => {
  const { state, builder, blockers } = fixture();
  const removable = blockers[0];
  assert.ok(removable);
  state.structures = state.structures.filter((structure) => structure.id !== removable.id);
  assert.equal(settlementMigrationPressure(state, builder.factionId), false);
  assert.equal(planAutonomousSettlementMigration(state, eastHalo()), undefined);
});

test("migration kit transfer conserves spendable plus carried camp materials", () => {
  const { state, builder, faction } = fixture();
  const beforeWood = faction.resources.wood + builder.inventory.wood;
  const beforeStone = faction.resources.stone + builder.inventory.stone;
  assert.equal(prepareSettlementMigrationKit(state, builder.id), true);
  assert.equal(builder.inventory.wood, 8);
  assert.equal(builder.inventory.stone, 4);
  assert.equal(faction.resources.wood + builder.inventory.wood, beforeWood);
  assert.equal(faction.resources.stone + builder.inventory.stone, beforeStone);
});

test("migration does not start below settlement capacity", () => {
  const { state, builder } = fixture();
  state.agents = state.agents.slice(0, 5);
  assert.equal(settlementMigrationPressure(state, builder.factionId), false);
  assert.equal(planAutonomousSettlementMigration(state, eastHalo()), undefined);
});
