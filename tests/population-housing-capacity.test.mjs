import assert from "node:assert/strict";
import test from "node:test";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("active camps bound population growth until residential capacity expands", () => {
  const state = createInitialWorld({ seed: 2030 });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const templates = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(templates.length >= 2);

  for (const tile of state.tiles) {
    if (tile.terrain === "water") tile.terrain = "plain";
  }

  state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
  for (let index = 0; index < 6; index += 1) {
    const template = structuredClone(templates[index % templates.length]);
    assert.ok(template);
    template.id = `housing-capacity-member-${index + 1}`;
    template.name = `Housing Member ${index + 1}`;
    template.hp = 100;
    template.energy = 100;
    template.autonomy = false;
    delete template.task;
    state.agents.push(template);
  }

  const campPosition = { ...state.agents.find((agent) => agent.factionId === faction.id).position };
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
  state.tick = 59;

  const blocked = new WorldRuntime({ state }).tick().state;
  const blockedFaction = blocked.factions.find((entry) => entry.id === faction.id);
  const blockedCamp = blocked.structures.find((structure) => structure.id === "housing-camp-a");
  assert.ok(blockedFaction);
  assert.ok(blockedCamp);
  assert.equal(blocked.agents.filter((agent) => agent.factionId === faction.id).length, 6);
  assert.equal(blockedFaction.resources.food, 100);
  assert.equal(blockedCamp.storage.food, 100);

  const secondCampPosition = blocked.tiles.find((tile) =>
    tile.terrain !== "water" &&
    (tile.x !== campPosition.x || tile.y !== campPosition.y)
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
  blocked.tick = 119;

  const expanded = new WorldRuntime({ state: blocked }).tick().state;
  const expandedFaction = expanded.factions.find((entry) => entry.id === faction.id);
  const expandedCamp = expanded.structures.find((structure) => structure.id === "housing-camp-a");
  assert.ok(expandedFaction);
  assert.ok(expandedCamp);
  assert.equal(expanded.agents.filter((agent) => agent.factionId === faction.id).length, 7);
  assert.equal(expandedFaction.resources.food, 94);
  assert.equal(expandedCamp.storage.food, 94);
});
