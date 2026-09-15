import assert from "node:assert/strict";
import test from "node:test";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("conception avoids close kin and prefers recent social familiarity", () => {
  const state = createInitialWorld({ seed: 26091601 });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const templates = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(templates.length >= 2);
  for (const tile of state.tiles) {
    if (tile.terrain === "water") tile.terrain = "plain";
  }

  const position = {
    x: Math.max(1, Math.min(state.width - 2, templates[0].position.x)),
    y: Math.max(1, Math.min(state.height - 2, templates[0].position.y)),
  };
  state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
  let templateIndex = 0;
  const makeMember = (id, name, reproductiveRole, memberPosition) => {
    const agent = structuredClone(templates[templateIndex % templates.length]);
    templateIndex += 1;
    assert.ok(agent);
    agent.id = id;
    agent.name = name;
    agent.position = memberPosition;
    agent.hp = 100;
    agent.energy = 100;
    agent.autonomy = false;
    agent.reproductiveRole = reproductiveRole;
    delete agent.pregnancy;
    delete agent.lastBirthTick;
    delete agent.parents;
    delete agent.task;
    return agent;
  };

  const parent = makeMember("pair-parent", "Pair Parent", "gestational", { ...position });
  parent.parents = ["founder-a", "founder-b"];
  const sibling = makeMember("pair-sibling", "Pair Sibling", "partner", { ...position });
  sibling.parents = ["founder-a", "founder-b"];
  const near = makeMember("pair-near", "Pair Near", "partner", { ...position });
  const familiar = makeMember(
    "pair-familiar",
    "Pair Familiar",
    "partner",
    { x: position.x + 1, y: position.y },
  );
  state.agents.push(parent, sibling, near, familiar);

  state.structures = state.structures.filter((structure) => structure.factionId !== faction.id);
  state.structures.push({
    id: "pairing-camp",
    factionId: faction.id,
    type: "camp",
    position: { ...position },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 100 },
  });
  faction.resources.food = 100;
  state.tick = 8_639;

  for (let index = 0; index < 3; index += 1) {
    state.events.push({
      id: `kin-conversation-${index}`,
      tick: 8_600 + index,
      kind: "agent_conversation",
      message: "kin talk",
      agentId: parent.id,
      factionId: faction.id,
      position: { ...position },
      data: { targetAgentId: sibling.id },
    });
  }
  for (let index = 0; index < 2; index += 1) {
    state.events.push({
      id: `familiar-conversation-${index}`,
      tick: 8_610 + index,
      kind: "agent_conversation",
      message: "familiar talk",
      agentId: parent.id,
      factionId: faction.id,
      position: { ...position },
      data: { targetAgentId: familiar.id },
    });
  }

  const next = new WorldRuntime({ state }).tick().state;
  const conceived = next.agents.find((agent) => agent.id === parent.id);
  assert.ok(conceived);
  assert.equal(conceived.pregnancy?.partnerId, familiar.id);
  assert.notEqual(conceived.pregnancy?.partnerId, sibling.id);
  assert.notEqual(conceived.pregnancy?.partnerId, near.id);
});
