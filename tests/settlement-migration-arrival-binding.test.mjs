import assert from "node:assert/strict";
import test from "node:test";
import {
  attachAgentOwnership,
  detachAgentOwnership,
  globalHandoffAgentId,
} from "../dist-ts/src/agent-ownership.js";
import { hexGridBoundaryCells, hexGridHandoffTarget } from "../dist-ts/src/hex-grid.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("arriving pioneer stays bound to a target-local camp that completes before its turn", () => {
  const source = createInitialWorld({ seed: 260914, width: 40, height: 24, regionId: "garden-1" });
  const target = createInitialWorld({ seed: 260915, width: 40, height: 24, regionId: "garden-2" });
  const pioneer = source.agents.find((agent) => agent.role === "builder");
  assert.ok(pioneer);
  const localBuilder = target.agents.find(
    (agent) => agent.role === "builder" && agent.factionId === pioneer.factionId,
  );
  assert.ok(localBuilder);

  const sourceCell = hexGridBoundaryCells(source, "east")[11];
  assert.ok(sourceCell);
  const targetCell = hexGridHandoffTarget(source, sourceCell, "east");
  assert.ok(targetCell);
  const targetTile = target.tiles[targetCell.y * target.width + targetCell.x];
  assert.ok(targetTile);
  targetTile.terrain = "plain";
  delete targetTile.resource;

  target.tick = 73;
  const camp = {
    id: "target-camp-in-progress",
    factionId: pioneer.factionId,
    type: "camp",
    position: { ...targetCell },
    status: "building",
    progress: BUILD_RECIPES.camp.work - 1,
    requiredProgress: BUILD_RECIPES.camp.work,
    storage: { wood: 0, stone: 0, food: 0 },
  };
  target.structures = [camp];
  target.agents = [localBuilder];
  localBuilder.id = "agent-a-local-finisher";
  localBuilder.autonomy = false;
  localBuilder.energy = 100;
  localBuilder.position = { ...targetCell };
  localBuilder.task = {
    source: "autonomy",
    issuedAtTick: target.tick,
    type: "build",
    structureType: "camp",
    target: { ...targetCell },
    structureId: camp.id,
  };
  const targetFaction = target.factions.find((faction) => faction.id === pioneer.factionId);
  assert.ok(targetFaction);
  targetFaction.resources = { wood: 100, stone: 100, food: 100 };

  pioneer.autonomy = true;
  pioneer.energy = 100;
  pioneer.position = { ...sourceCell };
  pioneer.inventory = { ...BUILD_RECIPES.camp.cost };
  pioneer.task = {
    source: "autonomy",
    issuedAtTick: source.tick,
    type: "move",
    target: { ...sourceCell },
  };

  const detached = detachAgentOwnership(source, [], pioneer.id);
  assert.equal(detached.ok, true);
  const attached = attachAgentOwnership(
    target,
    [],
    detached.value.agent,
    targetCell,
    source.regionId,
  );
  assert.equal(attached.ok, true);

  const arrivedId = globalHandoffAgentId(pioneer.id, source.regionId);
  const arrived = attached.value.state.agents.find((agent) => agent.id === arrivedId);
  assert.ok(arrived);
  assert.deepEqual(arrived.task, {
    source: "autonomy",
    issuedAtTick: target.tick,
    type: "build",
    structureType: "camp",
    target: { ...targetCell },
    structureId: camp.id,
  });

  const advanced = simulate(attached.value.state).state;
  const camps = advanced.structures.filter(
    (structure) => structure.factionId === pioneer.factionId && structure.type === "camp",
  );
  assert.equal(camps.length, 1, "the pioneer must not found a second camp after the first completes");
  assert.equal(camps[0]?.id, camp.id);
  assert.equal(camps[0]?.status, "active");
  const advancedPioneer = advanced.agents.find((agent) => agent.id === arrivedId);
  assert.ok(advancedPioneer);
  assert.equal(advancedPioneer.task, undefined);
  assert.deepEqual(
    advancedPioneer.inventory,
    BUILD_RECIPES.camp.cost,
    "the carried founding kit remains conserved for later local reuse",
  );
});
