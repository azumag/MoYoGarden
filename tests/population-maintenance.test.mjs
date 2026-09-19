import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPopulationAging,
  POPULATION_BASAL_FOOD_INTERVAL_TICKS,
  POPULATION_MAINTENANCE_INTERVAL_TICKS,
} from "../dist-ts/src/demography.js";
import { emptyInventory } from "../dist-ts/src/protocol.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function demographicFixture(food = 10) {
  const state = createInitialWorld({ seed: 9410, width: 40, height: 24, regionId: "garden-1" });
  const faction = state.factions[0]; assert.ok(faction);
  const members = state.agents.filter((agent) => agent.factionId === faction.id);
  const parent = members[0]; assert.ok(parent);
  const partner = members[1]; assert.ok(partner);

  for (const structure of state.structures) {
    if (structure.factionId === faction.id) structure.storage.food = 0;
  }
  faction.resources.food = food;
  state.structures.push({
    id: "demography-maintenance-store",
    factionId: faction.id,
    type: "storehouse",
    position: { ...parent.position },
    status: "active",
    progress: 10,
    requiredProgress: 10,
    storage: { wood: 0, stone: 0, food },
  });

  parent.energy = 80;
  partner.energy = 80;
  parent.pregnancy = {
    partnerId: partner.id,
    conceivedAtTick: 0,
    dueAtTick: POPULATION_MAINTENANCE_INTERVAL_TICKS * 2,
  };

  const child = {
    id: "agent-demography-dependent",
    name: "Dependent",
    factionId: faction.id,
    role: "forager",
    position: { ...parent.position },
    hp: 100,
    energy: 50,
    capacity: 8,
    inventory: emptyInventory(),
    autonomy: false,
    goal: "Grow safely before joining settlement work",
    status: "infant; dependent on parents",
    birthTick: 0,
    lifeStage: "infant",
    reproductiveRole: "partner",
    parents: [parent.id, partner.id],
  };
  state.agents.push(child);
  state.tick = POPULATION_MAINTENANCE_INTERVAL_TICKS;
  return { state, faction, parent, partner, child };
}

test("pregnancy and dependent care consume stored food and caregiver energy", () => {
  const { state, faction, parent, partner, child } = demographicFixture(10);
  applyPopulationAging(state);

  const storage = state.structures.find((structure) => structure.id === "demography-maintenance-store");
  assert.ok(storage);
  assert.equal(faction.resources.food, 8);
  assert.equal(storage.storage.food, 8);
  assert.equal(parent.energy, 76);
  assert.equal(partner.energy, 80);
  assert.equal(child.energy, 56);
  assert.equal(child.status, "infant; dependent on parents");
});

test("food scarcity is reflected in pregnant and dependent energy without inventing food", () => {
  const { state, faction, parent, child } = demographicFixture(0);
  applyPopulationAging(state);

  assert.equal(faction.resources.food, 0);
  assert.equal(parent.energy, 72);
  assert.equal(parent.hp, 99);
  assert.equal(parent.status, "pregnant; food insecure");
  assert.equal(child.energy, 42);
  assert.equal(child.hp, 99);
  assert.equal(child.status, "infant; food insecure");
});

test("demographic maintenance only runs on its bounded cadence", () => {
  const { state, faction, parent, child } = demographicFixture(10);
  state.tick = POPULATION_MAINTENANCE_INTERVAL_TICKS - 1;
  applyPopulationAging(state);

  const storage = state.structures.find((structure) => structure.id === "demography-maintenance-store");
  assert.ok(storage);
  assert.equal(faction.resources.food, 10);
  assert.equal(storage.storage.food, 10);
  assert.equal(parent.energy, 80);
  assert.equal(child.energy, 50);
});


test("basal metabolism makes every living resident consume food even while idle", () => {
  const state = createInitialWorld({ seed: 9411, width: 40, height: 24, regionId: "garden-1" });
  const faction = state.factions[0]; assert.ok(faction);
  const residents = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(residents.length > 0);

  for (const structure of state.structures) {
    if (structure.factionId === faction.id) structure.storage.food = 0;
  }
  const food = residents.length + 4;
  faction.resources.food = food;
  state.structures.push({
    id: "basal-metabolism-store",
    factionId: faction.id,
    type: "storehouse",
    position: { ...residents[0].position },
    status: "active",
    progress: 10,
    requiredProgress: 10,
    storage: { wood: 0, stone: 0, food },
  });
  for (const resident of residents) {
    resident.autonomy = false;
    resident.energy = 80;
    resident.hp = 100;
    delete resident.pregnancy;
  }

  state.tick = POPULATION_BASAL_FOOD_INTERVAL_TICKS;
  applyPopulationAging(state);

  const storage = state.structures.find((structure) => structure.id === "basal-metabolism-store");
  assert.ok(storage);
  assert.equal(faction.resources.food, 4);
  assert.equal(storage.storage.food, 4);
  assert.ok(residents.every((resident) => resident.hp === 100 && resident.energy === 80));
});

test("persistent food deficit can kill an idle legacy founder without a population cap", () => {
  const state = createInitialWorld({ seed: 9412, width: 40, height: 24, regionId: "garden-1" });
  const faction = state.factions[0]; assert.ok(faction);
  const victim = state.agents.find((agent) => agent.factionId === faction.id); assert.ok(victim);
  state.agents = [victim];
  victim.autonomy = false;
  victim.hp = 2;
  victim.energy = 16;
  delete victim.birthTick;
  delete victim.pregnancy;
  faction.resources.food = 0;
  for (const structure of state.structures) structure.storage.food = 0;

  state.tick = POPULATION_BASAL_FOOD_INTERVAL_TICKS;
  applyPopulationAging(state);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0]?.hp, 1);
  assert.equal(state.agents[0]?.energy, 8);
  assert.equal(state.agents[0]?.status, "starving; basal food deficit");

  state.tick = POPULATION_BASAL_FOOD_INTERVAL_TICKS * 2;
  applyPopulationAging(state);
  assert.equal(state.agents.length, 0);
});

test("scarce daily food rotates deterministically instead of starving the same resident forever", () => {
  const state = createInitialWorld({ seed: 9413, width: 40, height: 24, regionId: "garden-1" });
  const faction = state.factions[0]; assert.ok(faction);
  const residents = state.agents.filter((agent) => agent.factionId === faction.id).slice(0, 2);
  assert.equal(residents.length, 2);
  state.agents = residents;
  for (const resident of residents) {
    resident.autonomy = false;
    resident.hp = 100;
    resident.energy = 80;
    delete resident.pregnancy;
  }
  for (const structure of state.structures) structure.storage.food = 0;
  const position = { ...residents[0].position };
  state.structures.push({
    id: "rotating-basal-store",
    factionId: faction.id,
    type: "storehouse",
    position,
    status: "active",
    progress: 10,
    requiredProgress: 10,
    storage: { wood: 0, stone: 0, food: 1 },
  });
  faction.resources.food = 1;

  state.tick = POPULATION_BASAL_FOOD_INTERVAL_TICKS;
  applyPopulationAging(state);

  const storage = state.structures.find((structure) => structure.id === "rotating-basal-store");
  assert.ok(storage);
  storage.storage.food = 1;
  faction.resources.food = 1;
  state.tick = POPULATION_BASAL_FOOD_INTERVAL_TICKS * 2;
  applyPopulationAging(state);

  assert.equal(state.agents.length, 2);
  assert.deepEqual(
    state.agents.map((agent) => agent.hp).sort((a, b) => a - b),
    [99, 99],
  );
  assert.deepEqual(
    state.agents.map((agent) => agent.energy).sort((a, b) => a - b),
    [72, 72],
  );
});
