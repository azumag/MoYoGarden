import assert from "node:assert/strict";
import test from "node:test";
import {
  detachAgentOwnership,
  globalHandoffAgentId,
} from "../dist-ts/src/agent-ownership.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("detaching a counterparty promotes a resident autonomous trade target", () => {
  const state = createInitialWorld({
    seed: 9411,
    width: 40,
    height: 24,
    regionId: "garden-1",
  });
  const moving = state.agents[0];
  const trader = state.agents.find((agent) => agent.id !== moving?.id);
  assert.ok(moving);
  assert.ok(trader);

  trader.task = {
    source: "autonomy",
    issuedAtTick: state.tick - 100,
    type: "trade",
    targetAgentId: moving.id,
    offer: { wood: 1, stone: 0, food: 0 },
    request: { wood: 0, stone: 1, food: 0 },
  };
  const originalTask = structuredClone(trader.task);

  const detached = detachAgentOwnership(state, [], moving.id);
  assert.equal(detached.ok, true);

  const resident = detached.value.snapshot.state.agents.find((agent) => agent.id === trader.id);
  assert.ok(resident);
  assert.equal(resident.task?.type, "trade");
  assert.equal(
    resident.task.targetAgentId,
    globalHandoffAgentId(moving.id, state.regionId),
    "the trade promise must follow the counterparty's promoted world-global identity",
  );
  assert.deepEqual(resident.task.offer, originalTask.offer);
  assert.deepEqual(resident.task.request, originalTask.request);
  assert.equal(
    resident.task.issuedAtTick,
    state.tick,
    "promoting the counterparty should open a fresh bounded remote-discovery window",
  );
  assert.notEqual(resident.task.issuedAtTick, originalTask.issuedAtTick);
});

test("detaching a counterparty does not retarget an external trade task", () => {
  const state = createInitialWorld({
    seed: 9412,
    width: 40,
    height: 24,
    regionId: "garden-1",
  });
  const moving = state.agents[0];
  const trader = state.agents.find((agent) => agent.id !== moving?.id);
  assert.ok(moving);
  assert.ok(trader);

  trader.task = {
    source: "external",
    issuedAtTick: state.tick,
    type: "trade",
    targetAgentId: moving.id,
    offer: { wood: 1, stone: 0, food: 0 },
    request: { wood: 0, stone: 1, food: 0 },
  };

  const detached = detachAgentOwnership(state, [], moving.id);
  assert.equal(detached.ok, true);

  const resident = detached.value.snapshot.state.agents.find((agent) => agent.id === trader.id);
  assert.ok(resident);
  assert.equal(resident.task?.type, "trade");
  assert.equal(
    resident.task.targetAgentId,
    moving.id,
    "external source-local commands must not be silently rewritten into cross-region intent",
  );
});
