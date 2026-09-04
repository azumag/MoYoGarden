import assert from "node:assert/strict";
import test from "node:test";
import {
  activeAgentOwnershipCount,
  attachAgentOwnership,
  detachAgentOwnership,
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

test("attach preserves identity and inventory but clears source-local task state", () => {
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

  const attached = attachAgentOwnership(target, [], detached.value.agent, targetCell);
  assert.equal(attached.ok, true);
  const arrived = attached.value.state.agents.find((entry) => entry.id === agent.id);
  assert.ok(arrived);
  assert.deepEqual(arrived.position, targetCell);
  assert.deepEqual(arrived.inventory, { wood: 5, stone: 1, food: 2 });
  assert.equal(arrived.goal, agent.goal);
  assert.equal(arrived.task, undefined);
  assert.equal(arrived.status, "arrived from neighboring region");
});

test("attach rejects duplicate, impassable, and non-hex ownership targets", () => {
  const { source, target } = worlds();
  const agent = structuredClone(source.agents[0]);
  assert.ok(agent);

  const duplicate = attachAgentOwnership(target, [], target.agents[0], target.agents[0].position);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason, /already active/);

  const active = hexGridBoundaryCells(target, "west")[11];
  assert.ok(active);
  const tile = target.tiles[active.y * target.width + active.x];
  assert.ok(tile);
  tile.terrain = "water";
  const water = attachAgentOwnership(target, [], agent, active);
  assert.equal(water.ok, false);
  assert.match(water.reason, /impassable/);

  const outside = attachAgentOwnership(target, [], agent, { x: 0, y: 0 });
  assert.equal(outside.ok, false);
  assert.match(outside.reason, /outside the active hex/);
});

test("detach plus attach moves active ownership from exactly one region to exactly one region", () => {
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
  assert.equal(activeAgentOwnershipCount([source, target], agent.id), 1);
  const detached = detachAgentOwnership(source, [], agent.id);
  assert.equal(detached.ok, true);
  assert.equal(activeAgentOwnershipCount([detached.value.snapshot.state, target], agent.id), 0);

  const attached = attachAgentOwnership(target, [], detached.value.agent, targetCell);
  assert.equal(attached.ok, true);
  assert.equal(
    activeAgentOwnershipCount([detached.value.snapshot.state, attached.value.state], agent.id),
    1,
  );
});
