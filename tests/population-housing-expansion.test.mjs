import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const emptyInventory = () => ({ wood: 0, stone: 0, food: 0 });

function activeStructure(id, factionId, type, position, storage = emptyInventory()) {
  return {
    id,
    factionId,
    type,
    position: { ...position },
    status: "active",
    progress: 1,
    requiredProgress: 1,
    storage: { ...storage },
  };
}

test("housing pressure makes one autonomous builder start a resource-paid camp expansion", () => {
  const migrated = simulate(createInitialWorld({ seed: 2031 })).state;
  const faction = migrated.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const templates = migrated.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(templates.length >= 2);

  const campPosition = { ...templates[0].position };
  const nearby = migrated.tiles
    .filter((tile) => tile.terrain !== "water")
    .filter((tile) => tile.x !== campPosition.x || tile.y !== campPosition.y)
    .sort((a, b) => {
      const da = Math.max(
        Math.abs(a.x - campPosition.x),
        Math.abs(a.y - campPosition.y),
        Math.abs((a.x - campPosition.x) + (a.y - campPosition.y)),
      );
      const db = Math.max(
        Math.abs(b.x - campPosition.x),
        Math.abs(b.y - campPosition.y),
        Math.abs((b.x - campPosition.x) + (b.y - campPosition.y)),
      );
      return da - db || a.y - b.y || a.x - b.x;
    });
  assert.ok(nearby.length >= 9);

  const state = structuredClone(migrated);
  state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
  for (let index = 0; index < 6; index += 1) {
    const agent = structuredClone(templates[index % templates.length]);
    agent.id = index < 2 ? `housing-builder-${index + 1}` : `housing-resident-${index + 1}`;
    agent.name = index < 2 ? `Housing Builder ${index + 1}` : `Housing Resident ${index + 1}`;
    agent.role = index < 2 ? "builder" : "forager";
    agent.position = { ...campPosition };
    agent.hp = 100;
    agent.energy = 100;
    agent.inventory = emptyInventory();
    agent.autonomy = index < 2;
    delete agent.task;
    state.agents.push(agent);
  }

  state.structures = state.structures.filter((structure) => structure.factionId !== faction.id);
  state.structures.push(
    activeStructure("housing-camp-a", faction.id, "camp", campPosition, { wood: 20, stone: 20, food: 20 }),
    activeStructure("housing-storehouse", faction.id, "storehouse", nearby[5], { wood: 60, stone: 60, food: 60 }),
    activeStructure("housing-market", faction.id, "market", nearby[6]),
    activeStructure("housing-workshop", faction.id, "workshop", nearby[7]),
  );
  const ownedFaction = state.factions.find((entry) => entry.id === faction.id);
  assert.ok(ownedFaction);
  ownedFaction.resources = { wood: 80, stone: 80, food: 80 };

  const planned = simulate(state).state;
  const campPlans = planned.agents.filter(
    (agent) => agent.factionId === faction.id && agent.task?.type === "build" && agent.task.structureType === "camp",
  );
  assert.equal(campPlans.length, 1, "housing pressure should reserve only one new camp site per tick");
  assert.equal(
    planned.structures.filter((structure) => structure.factionId === faction.id && structure.type === "camp").length,
    1,
    "the first tick should travel to the reserved site before paying construction cost",
  );

  const started = simulate(planned).state;
  const camps = started.structures.filter(
    (structure) => structure.factionId === faction.id && structure.type === "camp",
  );
  assert.equal(camps.length, 2);
  assert.equal(camps.filter((structure) => structure.status === "building").length, 1);
  const startedFaction = started.factions.find((entry) => entry.id === faction.id);
  assert.ok(startedFaction);
  assert.deepEqual(startedFaction.resources, { wood: 72, stone: 76, food: 80 });
});
