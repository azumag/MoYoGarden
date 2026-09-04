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
  assert.equal(conversation.data?.adviceAccepted, undefined);
  assert.match(conversation.message, /gathering wood near 9,6/);
  assert.equal(second.task.resource, "stone");

  state.tick = 24;
  assert.equal(applySocialInteractions(state), 0);
  assert.equal(state.events.filter((event) => event.kind === "agent_conversation").length, 1);

  state.tick = 72;
  second.position = { x: 12, y: 6 };
  assert.equal(applySocialInteractions(state), 0);
});

test("a useful resource report can retarget an autonomous specialist", () => {
  const state = createInitialWorld({ seed: 6062, width: 16, height: 12 });
  const [first, second] = firstFactionPair(state);
  assert.ok(first);
  assert.ok(second);
  const sharedTile = state.tiles.find((tile) =>
    tile.terrain !== "water" && tile.x > 0 && tile.x < state.width - 1 && tile.y > 0 && tile.y < state.height - 1
  );
  assert.ok(sharedTile);

  state.agents = [first, second];
  state.tick = 12;
  first.position = { x: sharedTile.x - 1, y: sharedTile.y };
  second.position = { x: sharedTile.x, y: sharedTile.y };
  first.energy = 80;
  second.energy = 80;
  second.role = "woodcutter";
  first.task = {
    source: "autonomy",
    issuedAtTick: 11,
    type: "gather",
    resource: "wood",
    target: { x: sharedTile.x, y: sharedTile.y },
  };
  second.task = {
    source: "autonomy",
    issuedAtTick: 11,
    type: "gather",
    resource: "wood",
    target: { x: state.width - 1, y: state.height - 1 },
  };

  assert.equal(applySocialInteractions(state), 1);
  assert.deepEqual(second.task, {
    source: "autonomy",
    issuedAtTick: 12,
    type: "gather",
    resource: "wood",
    target: { x: sharedTile.x, y: sharedTile.y },
  });
  assert.match(second.status, /following .* wood report/);
  const conversation = state.events.at(-1);
  assert.equal(conversation?.data?.adviceAccepted, true);
  assert.deepEqual(conversation?.data?.adviceTarget, { x: sharedTile.x, y: sharedTile.y });
});

test("social advice never overrides an external task", () => {
  const state = createInitialWorld({ seed: 6063, width: 16, height: 12 });
  const [first, second] = firstFactionPair(state);
  assert.ok(first);
  assert.ok(second);

  state.agents = [first, second];
  state.tick = 12;
  first.position = { x: 6, y: 6 };
  second.position = { x: 7, y: 6 };
  first.energy = 80;
  second.energy = 80;
  second.role = "woodcutter";
  first.task = {
    source: "autonomy",
    issuedAtTick: 11,
    type: "gather",
    resource: "wood",
    target: { x: 8, y: 6 },
  };
  second.task = {
    source: "external",
    issuedAtTick: 11,
    type: "gather",
    resource: "wood",
    target: { x: 13, y: 6 },
  };

  assert.equal(applySocialInteractions(state), 1);
  assert.equal(second.task.source, "external");
  assert.deepEqual(second.task.target, { x: 13, y: 6 });
  assert.equal(state.events.at(-1)?.data?.adviceAccepted, undefined);
});

test("idle allies can react to a faction supply shortage as shared advice", () => {
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
  second.role = "scout";
  delete first.task;
  delete second.task;
  const faction = state.factions.find((entry) => entry.id === first.factionId);
  assert.ok(faction);
  faction.resources = { wood: 20, stone: 20, food: 0 };
  const foodTile = state.tiles.find((tile) => tile.terrain !== "water");
  assert.ok(foodTile);
  foodTile.resource = { kind: "food", amount: 8, maxAmount: 8 };

  assert.equal(applySocialInteractions(state), 1);
  const conversation = state.events.at(-1);
  assert.ok(conversation);
  assert.equal(conversation.kind, "agent_conversation");
  assert.equal(conversation.data?.topic, "supply_shortage");
  assert.equal(conversation.data?.resource, "food");
  assert.equal(conversation.data?.adviceAccepted, true);
  assert.match(conversation.message, /short on food/);
  assert.equal(second.task?.type, "gather");
  assert.equal(second.task?.resource, "food");
  assert.match(second.status, /helping with food shortage/);
});
