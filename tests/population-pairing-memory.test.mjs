import assert from "node:assert/strict";
import test from "node:test";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("conception prefers persisted social familiarity after conversation events expire", () => {
  const state = createInitialWorld({ seed: 26091613 });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const templates = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(templates.length >= 2);
  for (const tile of state.tiles) if (tile.terrain === "water") tile.terrain = "plain";

  const position = { x: 19, y: 11 };
  state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
  let templateIndex = 0;
  const makeMember = (id, reproductiveRole, memberPosition) => {
    const agent = structuredClone(templates[templateIndex % templates.length]);
    templateIndex += 1;
    assert.ok(agent);
    agent.id = id;
    agent.name = id;
    agent.position = memberPosition;
    agent.hp = 100;
    agent.energy = 100;
    agent.autonomy = false;
    agent.reproductiveRole = reproductiveRole;
    delete agent.pregnancy;
    delete agent.lastBirthTick;
    delete agent.parents;
    delete agent.socialMemory;
    delete agent.task;
    return agent;
  };

  const parent = makeMember("memory-parent", "gestational", { ...position });
  const stranger = makeMember("memory-stranger", "partner", { ...position });
  const familiar = makeMember("memory-familiar", "partner", { x: position.x + 1, y: position.y });
  parent.socialMemory = [{
    agentId: familiar.id,
    familiarity: 6,
    lastInteractionTick: 1_000,
  }];
  familiar.socialMemory = [{
    agentId: parent.id,
    familiarity: 6,
    lastInteractionTick: 1_000,
  }];
  state.agents.push(parent, stranger, familiar);

  state.structures = state.structures.filter((structure) => structure.factionId !== faction.id);
  state.structures.push({
    id: "memory-pairing-camp",
    factionId: faction.id,
    type: "camp",
    position: { ...position },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 100 },
  });
  faction.resources.food = 100;
  state.events = [];
  state.tick = 8_639;

  const next = new WorldRuntime({ state }).tick().state;
  const conceived = next.agents.find((agent) => agent.id === parent.id);
  assert.ok(conceived);
  assert.equal(conceived.pregnancy?.partnerId, familiar.id);
  assert.notEqual(conceived.pregnancy?.partnerId, stranger.id);
});
