import assert from "node:assert/strict";
import test from "node:test";
import {
  attachAgentOwnership,
  detachAgentOwnership,
  globalHandoffAgentId,
} from "../dist-ts/src/agent-ownership.js";
import { hexGridBoundaryCells } from "../dist-ts/src/hex-grid.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function passableBoundary(state, direction) {
  const position = hexGridBoundaryCells(state, direction)[11];
  assert.ok(position);
  const tile = state.tiles[position.y * state.width + position.x];
  assert.ok(tile);
  tile.terrain = "plain";
  return position;
}

test("routed autonomous trade survives one stale-owner attach but cannot chase forever", () => {
  const source = createInitialWorld({ seed: 9411, width: 40, height: 24, regionId: "garden-1" });
  const relay = createInitialWorld({ seed: 9412, width: 40, height: 24, regionId: "garden-2" });
  const next = createInitialWorld({ seed: 9413, width: 40, height: 24, regionId: "garden-3" });
  const agent = source.agents[0];
  assert.ok(agent);
  const globalTargetId = globalHandoffAgentId("agent-moved-again", "garden-9");
  const relayPosition = passableBoundary(relay, "west");
  const nextPosition = passableBoundary(next, "west");

  agent.task = {
    source: "autonomy",
    issuedAtTick: source.tick,
    type: "trade",
    targetAgentId: globalTargetId,
    offer: { wood: 1, stone: 0, food: 0 },
    request: { wood: 0, stone: 1, food: 0 },
    routeRegionId: relay.regionId,
    routeTarget: { ...relayPosition },
  };

  const detached = detachAgentOwnership(source, [], agent.id);
  assert.equal(detached.ok, true);
  relay.tick = 41;
  const firstAttach = attachAgentOwnership(
    relay,
    [],
    detached.value.agent,
    relayPosition,
    source.regionId,
  );
  assert.equal(firstAttach.ok, true);
  const globalTraderId = globalHandoffAgentId(agent.id, source.regionId);
  const relayed = firstAttach.value.state.agents.find((entry) => entry.id === globalTraderId);
  assert.ok(relayed);
  assert.deepEqual(relayed.task, {
    source: "autonomy",
    issuedAtTick: relay.tick,
    type: "trade",
    targetAgentId: globalTargetId,
    offer: { wood: 1, stone: 0, food: 0 },
    request: { wood: 0, stone: 1, food: 0 },
    handoffRetryBudget: 0,
  });
  assert.match(relayed.status, /resuming trade/);

  // Simulate the target moving again after the relay region has rediscovered a
  // neighboring route. The zero retry budget must make this second stale attach
  // fail closed rather than renewing the promise indefinitely.
  relayed.task.routeRegionId = next.regionId;
  relayed.task.routeTarget = { ...nextPosition };
  const detachedAgain = detachAgentOwnership(firstAttach.value.state, [], relayed.id);
  assert.equal(detachedAgain.ok, true);
  const secondAttach = attachAgentOwnership(
    next,
    [],
    detachedAgain.value.agent,
    nextPosition,
    relay.regionId,
  );
  assert.equal(secondAttach.ok, true);
  const arrivedAgain = secondAttach.value.state.agents.find((entry) => entry.id === globalTraderId);
  assert.ok(arrivedAgain);
  assert.equal(arrivedAgain.task, undefined);
  assert.equal(arrivedAgain.status, "arrived from neighboring region");
});
