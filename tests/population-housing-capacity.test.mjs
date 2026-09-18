import assert from "node:assert/strict";
import test from "node:test";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("housing capacity gates conception and birth follows a completed gestation", () => {
  const state = createInitialWorld({ seed: 2030 });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const templates = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(templates.length >= 2);

  for (const tile of state.tiles) {
    if (tile.terrain === "water") tile.terrain = "plain";
  }

  const campPosition = { ...templates[0].position };
  state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
  for (let index = 0; index < 6; index += 1) {
    const template = structuredClone(templates[index % templates.length]);
    assert.ok(template);
    template.id = `housing-capacity-member-${index + 1}`;
    template.name = `Housing Member ${index + 1}`;
    template.position = { ...campPosition };
    template.hp = 100;
    template.energy = 100;
    template.autonomy = false;
    template.reproductiveRole = index % 2 === 0 ? "gestational" : "partner";
    delete template.pregnancy;
    delete template.lastBirthTick;
    delete template.task;
    state.agents.push(template);
  }

  // This test is about housing capacity, not relationship formation. Give each
  // prospective pair a small persisted relationship so conception is otherwise
  // eligible once capacity exists.
  const householdMembers = state.agents.filter((agent) => agent.factionId === faction.id);
  for (let index = 0; index < householdMembers.length; index += 2) {
    const parent = householdMembers[index];
    const partner = householdMembers[index + 1];
    assert.ok(parent);
    assert.ok(partner);
    parent.socialMemory = [{ agentId: partner.id, familiarity: 3, lastInteractionTick: 1 }];
    partner.socialMemory = [{ agentId: parent.id, familiarity: 3, lastInteractionTick: 1 }];
  }

  state.structures = state.structures.filter((structure) => structure.factionId !== faction.id);
  state.structures.push({
    id: "housing-camp-a",
    factionId: faction.id,
    type: "camp",
    position: campPosition,
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 100 },
  });
  faction.resources.food = 100;
  state.tick = 8_639;

  const blocked = new WorldRuntime({ state }).tick().state;
  assert.equal(blocked.agents.filter((agent) => agent.factionId === faction.id).length, 6);
  assert.equal(blocked.agents.some((agent) => agent.factionId === faction.id && agent.pregnancy !== undefined), false);

  const secondCampPosition = blocked.tiles.find((tile) =>
    tile.terrain !== "water" && (tile.x !== campPosition.x || tile.y !== campPosition.y)
  );
  assert.ok(secondCampPosition);
  blocked.structures.push({
    id: "housing-camp-b",
    factionId: faction.id,
    type: "camp",
    position: { x: secondCampPosition.x, y: secondCampPosition.y },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  });
  blocked.tick = 17_279;

  const conceived = new WorldRuntime({ state: blocked }).tick().state;
  const gestationalParent = conceived.agents.find(
    (agent) => agent.factionId === faction.id && agent.pregnancy !== undefined,
  );
  assert.ok(gestationalParent);
  const partnerId = gestationalParent.pregnancy?.partnerId;
  assert.ok(partnerId);
  assert.equal(conceived.agents.filter((agent) => agent.factionId === faction.id).length, 6);
  assert.equal(gestationalParent.pregnancy?.conceivedAtTick, 17_280);
  assert.equal(gestationalParent.pregnancy?.dueAtTick, 25_920);
  assert.equal(conceived.factions.find((entry) => entry.id === faction.id)?.resources.food, 100);

  conceived.tick = 25_919;
  const born = new WorldRuntime({ state: conceived }).tick().state;
  const newborn = born.agents.find((agent) => agent.factionId === faction.id && agent.birthTick === 25_920);
  assert.ok(newborn);
  assert.equal(born.agents.filter((agent) => agent.factionId === faction.id).length, 7);
  assert.equal(newborn.lifeStage, "infant");
  assert.equal(newborn.autonomy, false);
  assert.deepEqual(newborn.position, gestationalParent.position);
  assert.deepEqual(newborn.parents, [gestationalParent.id, partnerId]);
  assert.equal(born.factions.find((entry) => entry.id === faction.id)?.resources.food, 94);
  assert.equal(born.structures.find((structure) => structure.id === "housing-camp-a")?.storage.food, 94);
});
