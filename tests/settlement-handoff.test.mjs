import assert from "node:assert/strict";
import test from "node:test";
import {
  attachAgentOwnership,
  detachAgentOwnership,
  globalHandoffAgentId,
} from "../dist-ts/src/agent-ownership.js";
import { hexGridBoundaryCells, hexGridHandoffTarget } from "../dist-ts/src/hex-grid.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { prepareSettlementMigrationKit } from "../dist-ts/src/settlement-migration.js";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function migrationWorlds() {
  const source = createInitialWorld({ seed: 26091281, width: 40, height: 24, regionId: "garden-1" });
  const target = createInitialWorld({ seed: 26091282, width: 40, height: 24, regionId: "garden-2" });
  const builder = source.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  const sourceCell = hexGridBoundaryCells(source, "east")[11];
  assert.ok(sourceCell);
  const targetCell = hexGridHandoffTarget(source, sourceCell, "east");
  assert.ok(targetCell);
  const targetTile = target.tiles[targetCell.y * target.width + targetCell.x];
  assert.ok(targetTile);
  targetTile.terrain = "plain";
  delete targetTile.resource;
  for (const agent of target.agents) {
    agent.autonomy = false;
    delete agent.task;
  }
  builder.autonomy = true;
  builder.position = { ...sourceCell };
  builder.inventory = { wood: 8, stone: 4, food: 0 };
  builder.task = {
    source: "autonomy",
    issuedAtTick: source.tick,
    type: "move",
    target: { ...sourceCell },
  };
  return { source, target, builder, sourceCell, targetCell };
}

test("pioneer arrival turns a carried camp kit into a target-local founding intent", () => {
  const { source, target, builder, sourceCell, targetCell } = migrationWorlds();
  target.structures = [];
  target.tick = 73;

  const detached = detachAgentOwnership(source, [], builder.id);
  assert.equal(detached.ok, true);
  const attached = attachAgentOwnership(
    target,
    [],
    detached.value.agent,
    targetCell,
    source.regionId,
  );
  assert.equal(attached.ok, true);

  const globalId = globalHandoffAgentId(builder.id, source.regionId);
  const arrived = attached.value.state.agents.find((agent) => agent.id === globalId);
  assert.ok(arrived);
  assert.deepEqual(arrived.inventory, { wood: 8, stone: 4, food: 0 });
  assert.deepEqual(arrived.task, {
    source: "autonomy",
    issuedAtTick: target.tick,
    type: "build",
    structureType: "camp",
    settlementPreviousRegionId: source.regionId,
  });
  assert.equal(arrived.status, "arrived from neighboring region; replanning camp build");

  const advanced = simulate(attached.value.state).state;
  const replanned = advanced.agents.find((agent) => agent.id === globalId);
  assert.ok(replanned);
  assert.equal(replanned.task?.type, "build");
  assert.equal(replanned.task?.structureType, "camp");
  assert.ok(replanned.task?.target, "arrival-side simulation should resolve a local camp site");
  assert.notDeepEqual(
    replanned.task.target,
    sourceCell,
    "source-local migration coordinates must not survive ownership handoff",
  );
});

test("pioneer joins an existing same-faction settlement instead of forcing a duplicate camp", () => {
  const { source, target, builder, targetCell } = migrationWorlds();
  target.tick = 79;
  target.structures = [{
    id: "target-camp",
    factionId: builder.factionId,
    type: "camp",
    position: { ...targetCell },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  }];

  const detached = detachAgentOwnership(source, [], builder.id);
  assert.equal(detached.ok, true);
  const attached = attachAgentOwnership(
    target,
    [],
    detached.value.agent,
    targetCell,
    source.regionId,
  );
  assert.equal(attached.ok, true);

  const globalId = globalHandoffAgentId(builder.id, source.regionId);
  const arrived = attached.value.state.agents.find((agent) => agent.id === globalId);
  assert.ok(arrived);
  assert.deepEqual(arrived.inventory, { wood: 8, stone: 4, food: 0 });
  assert.equal(arrived.task, undefined);
  assert.equal(arrived.status, "arrived from neighboring region");
  assert.equal(
    attached.value.state.structures.filter(
      (structure) => structure.factionId === builder.factionId && structure.type === "camp",
    ).length,
    1,
  );

  const advanced = simulate(attached.value.state).state;
  assert.equal(
    advanced.structures.filter(
      (structure) => structure.factionId === builder.factionId && structure.type === "camp",
    ).length,
    1,
    "joining must not manufacture another camp on the first target-side tick",
  );
});

test("pioneer carried kit funds frontier camp even beside existing non-camp storage", () => {
  const { source, target, builder, sourceCell, targetCell } = migrationWorlds();
  const sourceFaction = source.factions.find((entry) => entry.id === builder.factionId);
  const targetFaction = target.factions.find((entry) => entry.id === builder.factionId);
  assert.ok(sourceFaction);
  assert.ok(targetFaction);

  source.structures = [{
    id: "source-camp",
    factionId: builder.factionId,
    type: "camp",
    position: { ...sourceCell },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { ...BUILD_RECIPES.camp.cost },
  }];
  sourceFaction.resources = { ...BUILD_RECIPES.camp.cost };
  builder.inventory = { wood: 0, stone: 0, food: 0 };
  assert.equal(prepareSettlementMigrationKit(source, builder.id), true);
  assert.deepEqual(source.structures[0].storage, { wood: 0, stone: 0, food: 0 });
  assert.deepEqual(sourceFaction.resources, { wood: 0, stone: 0, food: 0 });
  assert.deepEqual(builder.inventory, BUILD_RECIPES.camp.cost);

  target.agents = [];
  target.structures = [{
    id: "target-storehouse",
    factionId: builder.factionId,
    type: "storehouse",
    position: { ...targetCell },
    status: "active",
    progress: 8,
    requiredProgress: 8,
    storage: { wood: 100, stone: 100, food: 100 },
  }];
  targetFaction.resources = { wood: 100, stone: 100, food: 100 };
  const targetWoodBefore = targetFaction.resources.wood;
  const targetStoneBefore = targetFaction.resources.stone;
  const targetStorehouse = target.structures[0];
  const storedWoodBefore = targetStorehouse.storage.wood;
  const storedStoneBefore = targetStorehouse.storage.stone;

  const detached = detachAgentOwnership(source, [], builder.id);
  assert.equal(detached.ok, true);
  const attached = attachAgentOwnership(
    target,
    [],
    detached.value.agent,
    targetCell,
    source.regionId,
  );
  assert.equal(attached.ok, true);

  const globalId = globalHandoffAgentId(builder.id, source.regionId);
  let advanced = attached.value.state;
  for (let step = 0; step < 20; step += 1) {
    advanced = simulate(advanced).state;
    if (advanced.structures.some((structure) =>
      structure.factionId === builder.factionId
      && structure.type === "camp"
      && structure.status === "active"
    )) break;
  }

  const arrived = advanced.agents.find((agent) => agent.id === globalId);
  const frontierCamp = advanced.structures.find((structure) =>
    structure.factionId === builder.factionId
    && structure.type === "camp"
    && structure.status === "active"
  );
  const destinationStorehouse = advanced.structures.find((structure) => structure.id === "target-storehouse");
  const destinationFaction = advanced.factions.find((entry) => entry.id === builder.factionId);
  assert.ok(arrived);
  assert.ok(frontierCamp, "carried kit should become one active frontier camp");
  assert.ok(destinationStorehouse);
  assert.ok(destinationFaction);
  assert.deepEqual(arrived.inventory, { wood: 0, stone: 0, food: 0 });
  assert.equal(destinationFaction.resources.wood, targetWoodBefore);
  assert.equal(destinationFaction.resources.stone, targetStoneBefore);
  assert.equal(destinationStorehouse.storage.wood, storedWoodBefore);
  assert.equal(destinationStorehouse.storage.stone, storedStoneBefore);
});

test("source-region migration marker does not spend the kit before handoff", () => {
  const { source, builder, sourceCell } = migrationWorlds();
  const faction = source.factions.find((entry) => entry.id === builder.factionId);
  assert.ok(faction);
  const buildTile = source.tiles[sourceCell.y * source.width + sourceCell.x];
  assert.ok(buildTile);
  buildTile.terrain = "plain";
  delete buildTile.resource;

  for (const agent of source.agents) {
    agent.autonomy = false;
    delete agent.task;
  }
  const storageTile = source.tiles.find((tile) =>
    tile.terrain !== "water"
    && (tile.x !== sourceCell.x || tile.y !== sourceCell.y)
  );
  assert.ok(storageTile);
  source.structures = [{
    id: "source-storehouse",
    factionId: builder.factionId,
    type: "storehouse",
    position: { x: storageTile.x, y: storageTile.y },
    status: "active",
    progress: 8,
    requiredProgress: 8,
    storage: { ...BUILD_RECIPES.camp.cost },
  }];
  faction.resources = { wood: 100, stone: 100, food: 100 };
  builder.position = { ...sourceCell };
  builder.inventory = { ...BUILD_RECIPES.camp.cost };
  builder.settlementMigrationOriginRegionId = source.regionId;
  builder.task = {
    source: "autonomy",
    issuedAtTick: source.tick,
    type: "build",
    structureType: "camp",
    target: { ...sourceCell },
  };

  const beforeFaction = { ...faction.resources };
  const advanced = simulate(source).state;
  const afterBuilder = advanced.agents.find((agent) => agent.id === builder.id);
  const afterFaction = advanced.factions.find((entry) => entry.id === builder.factionId);
  const afterStorehouse = advanced.structures.find((structure) => structure.id === "source-storehouse");
  assert.ok(afterBuilder);
  assert.ok(afterFaction);
  assert.ok(afterStorehouse);
  assert.ok(advanced.structures.some((structure) =>
    structure.factionId === builder.factionId
    && structure.type === "camp"
    && structure.status === "building"
  ));
  assert.deepEqual(
    afterBuilder.inventory,
    BUILD_RECIPES.camp.cost,
    "the migration kit is only frontier cargo after ownership has crossed into another region",
  );
  assert.equal(afterFaction.resources.wood, beforeFaction.wood - BUILD_RECIPES.camp.cost.wood);
  assert.equal(afterFaction.resources.stone, beforeFaction.stone - BUILD_RECIPES.camp.cost.stone);
  assert.equal(afterStorehouse.storage.wood, 0);
  assert.equal(afterStorehouse.storage.stone, 0);
});
