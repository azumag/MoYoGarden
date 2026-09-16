import assert from "node:assert/strict";
import test from "node:test";
import { applySocialInteractions } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("conversation records reciprocal bounded familiarity outside the event log", () => {
  const state = createInitialWorld({ seed: 26091612 });
  const factionId = state.agents[0]?.factionId;
  assert.ok(factionId);
  const pair = state.agents.filter((agent) => agent.factionId === factionId).slice(0, 2);
  assert.equal(pair.length, 2);
  const [first, second] = pair;
  assert.ok(first);
  assert.ok(second);
  second.position = { ...first.position };
  first.hp = second.hp = 100;
  first.energy = second.energy = 100;
  first.autonomy = second.autonomy = false;
  state.agents = [first, second];
  state.events = [];
  state.tick = 12;

  assert.equal(applySocialInteractions(state), 1);
  assert.deepEqual(first.socialMemory, [{
    agentId: second.id,
    familiarity: 1,
    lastInteractionTick: state.tick,
  }]);
  assert.deepEqual(second.socialMemory, [{
    agentId: first.id,
    familiarity: 1,
    lastInteractionTick: state.tick,
  }]);
  assert.equal(state.events.filter((event) => event.kind === "agent_conversation").length, 1);

  // Prove the relationship state is independent from bounded event retention.
  state.events = [];
  assert.equal(first.socialMemory?.[0]?.agentId, second.id);
  assert.equal(second.socialMemory?.[0]?.agentId, first.id);
});
