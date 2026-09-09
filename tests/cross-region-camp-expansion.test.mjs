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

test("cross-region camp expansion survives arrival beside an existing camp", () => {
  const source = createInitialWorld({ seed: 9401, width: 40, height: 24, regionId: "garden-1" });
  const target = createInitialWorld({ seed: 9402, width: 40, height: 24, regionId: "garden-2" });
  const builder = source.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);

  const sourceCell = hexGridBoundaryCells(source, "east")[11];
  assert.ok(sourceCell);
  const targetCell = hexGridHandoffTarget(source, sourceCell, "east");
  assert.ok(targetCell);
  const arrivalTile = target.tiles[targetCell.y * target.width + targetCell.x];
  assert.ok(arrivalTile);
  arrivalTile.terrain = "plain";
  delete arrivalTile.resource;

  const targetFaction = target.factions.find((faction) => faction.id === builder.factionId);
  assert.ok(targetFaction);
  targetFaction.resources = { wood: 100, stone: 100, food: 100 };

  const localResident = target.agents.find((agent) => agent.factionId === builder.factionId);
  assert.ok(localResident);
  const campTile = target.tiles[localResident.position.y * target.width + localResident.position.x];
  assert.ok(campTile);
  campTile.terrain = "plain";
  delete campTile.resource;
  target.structures = [{
    id: "target-existing-camp",
    factionId: builder.factionId,
    type: "camp",
    position: { ...localResident.position },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 20, stone: 20, food: 20 },
  }];
  for (const agent of target.agents) {
    agent.autonomy = false;
    delete agent.task;
  }
  for (const tile of target.tiles) {
    if (tile.terrain === "water") continue;
    delete tile.resource;
  }

  builder.position = { ...sourceCell };
  builder.task = {
    source: "autonomy",
    issuedAtTick: source.tick,
    type: "build",
    structureType: "camp",
    target: { ...sourceCell },
    structureId: "source-camp-expansion",
  };

  const detached = detachAgentOwnership(source, [], builder.id);
  assert.equal(detached.ok, true);
  assert.ok(detached.value);
  const attached = attachAgentOwnership(
    target,
    [],
    detached.value.agent,
    targetCell,
    source.regionId,
  );
  assert.equal(attached.ok, true);
  assert.ok(attached.value);

  const globalId = globalHandoffAgentId(builder.id, source.regionId);
  const arrived = attached.value.state.agents.find((agent) => agent.id === globalId);
  assert.ok(arrived);
  assert.deepEqual(arrived.task, {
    source: "autonomy",
    issuedAtTick: target.tick,
    type: "build",
    structureType: "camp",
  });

  const advanced = simulate(attached.value.state).state;
  const replanned = advanced.agents.find((agent) => agent.id === globalId);
  assert.ok(replanned);
  assert.equal(replanned.task?.type, "build");
  assert.equal(replanned.task?.structureType, "camp");
  assert.ok(replanned.task?.target, "repeatable camp build intent should resolve a destination-local site");
  assert.notEqual(replanned.status, "camp already available");
  assert.equal(
    advanced.structures.filter((structure) => structure.id === "target-existing-camp" && structure.status === "active").length,
    1,
    "the existing destination camp remains intact while expansion is replanned",
  );
});
