import assert from "node:assert/strict";
import test from "node:test";
import {
  activeAgentOwnershipCount,
  attachAgentOwnership,
  detachAgentOwnership,
  globalHandoffAgentId,
} from "../dist-ts/src/agent-ownership.js";
import { hexGridBoundaryCells, hexGridHandoffTarget } from "../dist-ts/src/hex-grid.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function worlds() {
  return {
    source: createInitialWorld({ seed: 9101, width: 40, height: 24, regionId: "garden-1" }),
    target: createInitialWorld({ seed: 9102, width: 40, height: 24, regionId: "garden-2" }),
  };
}

test("detach refuses to strand a queued command", () => {
  const { source } = worlds();
  const agent = source.agents[0];
  assert.ok(agent);
  const result = detachAgentOwnership(source, [{
    id: "queued-before-handoff",
    agentId: agent.id,
    submittedAtTick: source.tick,
    type: "set_goal",
    goal: "cross the region",
  }], agent.id);
  assert.equal(result.ok, false);
  assert.match(result.reason, /pending commands/);
  assert.ok(source.agents.some((entry) => entry.id === agent.id));
});

test("detach preserves the complete agent snapshot while removing active ownership", () => {
  const { source } = worlds();
  const agent = source.agents[0];
  assert.ok(agent);
  agent.inventory = { wood: 4, stone: 2, food: 3 };
  agent.energy = 73;
  agent.goal = "survey the next region";
  const expected = structuredClone(agent);

  const result = detachAgentOwnership(source, [], agent.id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.agent, expected);
  assert.equal(result.value.snapshot.state.agents.some((entry) => entry.id === agent.id), false);
  assert.ok(source.agents.some((entry) => entry.id === agent.id), "input state must remain immutable");
});

test("attach promotes a legacy local ID once, preserves inventory, and clears source-local task state", () => {
  const { source, target } = worlds();
  const agent = source.agents[0];
  assert.ok(agent);
  const sourceCell = hexGridBoundaryCells(source, "east")[11];
  assert.ok(sourceCell);
  const targetCell = hexGridHandoffTarget(source, sourceCell, "east");
  assert.ok(targetCell);
  const targetTile = target.tiles[targetCell.y * target.width + targetCell.x];
  assert.ok(targetTile);
  targetTile.terrain = "plain";
  delete targetTile.resource;

  agent.position = { ...sourceCell };
  agent.inventory = { wood: 5, stone: 1, food: 2 };
  agent.task = {
    source: "autonomy",
    issuedAtTick: source.tick,
    type: "move",
    target: { ...sourceCell },
  };
  const detached = detachAgentOwnership(source, [], agent.id);
  assert.equal(detached.ok, true);

  const attached = attachAgentOwnership(
    target,
    [],
    detached.value.agent,
    targetCell,
    source.regionId,
  );
  assert.equal(attached.ok, true);
  const globalId = globalHandoffAgentId(agent.id, source.regionId);
  const arrived = attached.value.state.agents.find((entry) => entry.id === globalId);
  assert.ok(arrived);
  assert.deepEqual(arrived.position, targetCell);
  assert.deepEqual(arrived.inventory, { wood: 5, stone: 1, food: 2 });
  assert.equal(arrived.goal, agent.goal);
  assert.equal(arrived.task, undefined);
  assert.equal(arrived.status, "arrived from neighboring region");
  assert.ok(attached.value.state.agents.some((entry) => entry.id === agent.id), "target legacy local remains distinct");
  assert.equal(globalHandoffAgentId(globalId, "garden-2"), globalId, "later handoffs keep the global id stable");
});

test("attach rejects duplicate promoted identity, impassable, and non-hex ownership targets", () => {
  const { source, target } = worlds();
  const agent = structuredClone(source.agents[0]);
  assert.ok(agent);
  const active = hexGridBoundaryCells(target, "west")[11];
  assert.ok(active);
  const tile = target.tiles[active.y * target.width + active.x];
  assert.ok(tile);
  tile.terrain = "plain";

  const first = attachAgentOwnership(target, [], agent, active, source.regionId);
  assert.equal(first.ok, true);
  const duplicate = attachAgentOwnership(first.value.state, [], agent, active, source.regionId);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason, /already active/);

  tile.terrain = "water";
  const water = attachAgentOwnership(target, [], agent, active, source.regionId);
  assert.equal(water.ok, false);
  assert.match(water.reason, /impassable/);

  const outside = attachAgentOwnership(target, [], agent, { x: 0, y: 0 }, source.regionId);
  assert.equal(outside.ok, false);
  assert.match(outside.reason, /outside the active hex/);
});

test("legacy collisions become unambiguous world-global ownership after the first handoff", () => {
  const { source, target } = worlds();
  const agent = source.agents[0];
  assert.ok(agent);
  const sourceCell = hexGridBoundaryCells(source, "northEast")[7];
  assert.ok(sourceCell);
  const targetCell = hexGridHandoffTarget(source, sourceCell, "northEast");
  assert.ok(targetCell);
  const targetTile = target.tiles[targetCell.y * target.width + targetCell.x];
  assert.ok(targetTile);
  targetTile.terrain = "plain";

  agent.position = { ...sourceCell };
  assert.equal(
    activeAgentOwnershipCount([source, target], agent.id),
    2,
    "legacy regions begin with ambiguous local ids",
  );
  const detached = detachAgentOwnership(source, [], agent.id);
  assert.equal(detached.ok, true);
  assert.equal(activeAgentOwnershipCount([detached.value.snapshot.state, target], agent.id), 1);

  const attached = attachAgentOwnership(
    target,
    [],
    detached.value.agent,
    targetCell,
    source.regionId,
  );
  assert.equal(attached.ok, true);
  const globalId = globalHandoffAgentId(agent.id, source.regionId);
  assert.equal(
    activeAgentOwnershipCount([detached.value.snapshot.state, attached.value.state], globalId),
    1,
  );
  assert.equal(
    activeAgentOwnershipCount([detached.value.snapshot.state, attached.value.state], agent.id),
    1,
    "the unrelated target-local legacy agent remains separate",
  );
});
