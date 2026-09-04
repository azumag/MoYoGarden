import assert from "node:assert/strict";
import test from "node:test";
import { applySocialInteractions } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function firstFactionPair(state) {
  return state.agents
    .filter((agent) => agent.factionId === state.agents[0]?.factionId)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 2);
}

test("nearby allies exchange task-grounded information without conversation spam", () => {
  const state = createInitialWorld({ seed: 6060, width: 16, height: 12 });
  const [first, second] = firstFactionPair(state);
  assert.ok(first);
  assert.ok(second);

  state.agents = [first, second];
  state.tick = 12;
  first.position = { x: 6, y: 6 };
  second.position = { x: 7, y: 6 };
  first.energy = 80;
  second.energy = 80;
  first.task = {
    source: "autonomy",
    issuedAtTick: 11,
    type: "gather",
    resource: "wood",
    target: { x: 9, y: 6 },
  };
  second.task = {
    source: "autonomy",
    issuedAtTick: 11,
    type: "gather",
    resource: "stone",
    target: { x: 4, y: 6 },
  };

  assert.equal(applySocialInteractions(state), 1);
  const conversation = state.events.at(-1);
  assert.ok(conversation);
  assert.equal(conversation.kind, "agent_conversation");
  assert.equal(conversation.agentId, first.id);
  assert.equal(conversation.data?.targetAgentId, second.id);
  assert.equal(conversation.data?.topic, "resource_report");
  assert.equal(conversation.data?.resource, "wood");
  assert.match(conversation.message, /gathering wood near 9,6/);

  state.tick = 24;
  assert.equal(applySocialInteractions(state), 0);
  assert.equal(state.events.filter((event) => event.kind === "agent_conversation").length, 1);

  state.tick = 72;
  second.position = { x: 12, y: 6 };
  assert.equal(applySocialInteractions(state), 0);
});

test("idle allies can surface a faction supply shortage as a conversation topic", () => {
  const state = createInitialWorld({ seed: 6061, width: 16, height: 12 });
  const [first, second] = firstFactionPair(state);
  assert.ok(first);
  assert.ok(second);

  state.agents = [first, second];
  state.tick = 12;
  first.position = { x: 5, y: 5 };
  second.position = { x: 5, y: 6 };
  first.energy = 80;
  second.energy = 80;
  delete first.task;
  delete second.task;
  const faction = state.factions.find((entry) => entry.id === first.factionId);
  assert.ok(faction);
  faction.resources = { wood: 20, stone: 20, food: 0 };

  assert.equal(applySocialInteractions(state), 1);
  const conversation = state.events.at(-1);
  assert.ok(conversation);
  assert.equal(conversation.kind, "agent_conversation");
  assert.equal(conversation.data?.topic, "supply_shortage");
  assert.equal(conversation.data?.resource, "food");
  assert.match(conversation.message, /short on food/);
});
