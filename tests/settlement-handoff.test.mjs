import assert from "node:assert/strict";
import test from "node:test";
import {
  attachAgentOwnership,
  detachAgentOwnership,
  globalHandoffAgentId,
} from "../dist-ts/src/agent-ownership.js";
import { hexGridBoundaryCells, hexGridHandoffTarget } from "../dist-ts/src/hex-grid.js";
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
