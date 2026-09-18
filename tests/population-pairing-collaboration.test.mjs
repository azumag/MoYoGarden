import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConstructionCollaborationFamiliarity,
} from "../dist-ts/src/demography.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function pairingFixture(seed) {
  const state = createInitialWorld({ seed });
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
    agent.lifeStage = "adult";
    agent.reproductiveRole = reproductiveRole;
    delete agent.birthTick;
    delete agent.pregnancy;
    delete agent.lastBirthTick;
    delete agent.parents;
    delete agent.socialMemory;
    delete agent.task;
    return agent;
  };

  const parent = makeMember("work-parent", "Work Parent", "gestational", { ...position });
  const collaborator = makeMember(
    "work-collaborator",
    "Work Collaborator",
    "partner",
    { x: position.x + 1, y: position.y },
  );
  const stranger = makeMember("work-stranger", "Work Stranger", "partner", { ...position });
  state.agents.push(parent, collaborator, stranger);

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
  state.structures.push({
    id: "shared-workshop",
    factionId: faction.id,
    type: "workshop",
    position: { x: position.x + 1, y: position.y },
    status: "active",
    progress: 13,
    requiredProgress: 13,
    storage: { wood: 0, stone: 0, food: 0 },
  });
  faction.resources.food = 100;
  state.events = [
    {
      id: "shared-work-start",
      tick: 8_100,
      kind: "construction_started",
      message: "shared workshop started",
      agentId: parent.id,
      factionId: faction.id,
      position: { ...position },
      data: { structureId: "shared-workshop", structureType: "workshop" },
    },
    {
      id: "shared-work-progress",
      tick: 8_500,
      kind: "construction_progress",
      message: "shared workshop progressed",
      agentId: collaborator.id,
      factionId: faction.id,
      position: { x: position.x + 1, y: position.y },
      data: { structureId: "shared-workshop", progress: 4 },
    },
  ];
  return { state, faction, parent, collaborator, stranger };
}

test("shared construction becomes bounded reciprocal familiarity exactly once", () => {
  const { state, parent, collaborator, stranger } = pairingFixture(26091801);
  state.tick = 8_639;

  assert.equal(applyConstructionCollaborationFamiliarity(state), 1);
  assert.deepEqual(parent.socialMemory, [{
    agentId: collaborator.id,
    familiarity: 1,
    lastInteractionTick: 8_500,
  }]);
  assert.deepEqual(collaborator.socialMemory, [{
    agentId: parent.id,
    familiarity: 1,
    lastInteractionTick: 8_500,
  }]);
  assert.equal(stranger.socialMemory, undefined);

  assert.equal(applyConstructionCollaborationFamiliarity(state), 0);
  assert.equal(parent.socialMemory?.[0]?.familiarity, 1);
  assert.equal(collaborator.socialMemory?.[0]?.familiarity, 1);
});

test("shared construction history can satisfy the relationship gate for conception", () => {
  const { state, parent, collaborator, stranger } = pairingFixture(26091802);
  state.tick = 8_639;
  assert.equal(state.events.some((event) => event.kind === "agent_conversation"), false);

  const next = new WorldRuntime({ state }).tick().state;
  const conceived = next.agents.find((agent) => agent.id === parent.id);
  assert.ok(conceived);
  assert.equal(conceived.pregnancy?.partnerId, collaborator.id);
  assert.notEqual(conceived.pregnancy?.partnerId, stranger.id);
});
