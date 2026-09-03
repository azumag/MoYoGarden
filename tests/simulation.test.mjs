import assert from "node:assert/strict";
import test from "node:test";
import { emptyInventory } from "../dist-ts/src/protocol.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { resourceRegrowthChance, simulate, surfaceMoistureAt } from "../dist-ts/src/simulation.js";
import { createInitialWorld, getPerception, validateWorldState } from "../dist-ts/src/world.js";

function advance(initial, ticks) {
  let state = initial;
  for (let index = 0; index < ticks; index += 1) state = simulate(state).state;
  return state;
}

test("same seed produces the same world", () => {
  assert.deepEqual(advance(createInitialWorld({ seed: 123456 }), 160), advance(createInitialWorld({ seed: 123456 }), 160));
});

test("organic resource regrowth responds to water and vegetation cover", () => {
  const state = createInitialWorld({ seed: 3030, width: 16, height: 12 });
  for (const tile of state.tiles) {
    if (tile.terrain === "water") tile.terrain = "plain";
  }

  const target = state.tiles.find((tile) => tile.x === 8 && tile.y === 6); assert.ok(target);
  target.terrain = "forest";
  target.resource = { kind: "wood", amount: 10, maxAmount: 10 };
  const lushMoisture = surfaceMoistureAt(state, target);

  target.resource.amount = 0;
  const degradedMoisture = surfaceMoistureAt(state, target);
  const dryRegrowth = resourceRegrowthChance(state, target);
  assert.ok(lushMoisture > degradedMoisture);

  const water = state.tiles.find((tile) => tile.x === 8 && tile.y === 5); assert.ok(water);
  water.terrain = "water";
  delete water.resource;
  const wetMoisture = surfaceMoistureAt(state, target);
  const wetRegrowth = resourceRegrowthChance(state, target);
  assert.ok(wetMoisture > degradedMoisture);
  assert.ok(wetRegrowth > dryRegrowth);

  target.terrain = "hill";
  target.resource = { kind: "stone", amount: 0, maxAmount: 10 };
  assert.equal(resourceRegrowthChance(state, target), 0.18);
});

test("autonomous factions complete the settlement loop", () => {
  const state = advance(createInitialWorld({ seed: 424242 }), 120);
  assert.deepEqual(validateWorldState(state), []);
  for (const faction of state.factions) {
    for (const type of ["camp", "storehouse", "market", "workshop"]) {
      assert.ok(state.structures.some((entry) => entry.factionId === faction.id && entry.type === type && entry.status === "active"));
    }
  }
});

test("perception remains local", () => {
  const state = createInitialWorld({ seed: 777 });
  const self = state.agents.find((agent) => agent.factionId === "ember");
  assert.ok(self);
  const perception = getPerception(state, self.id, 2);
  assert.equal(perception.radius, 2);
  assert.ok(perception.visibleTiles.length < state.tiles.length);
  assert.ok(perception.visibleTiles.every((tile) => Math.abs(tile.x-self.position.x)+Math.abs(tile.y-self.position.y) <= 2));
});

test("pending commands survive hibernation", () => {
  const runtime = new WorldRuntime({ seed: 99 });
  const agent = runtime.snapshot().agents[0]; assert.ok(agent);
  assert.equal(runtime.submit(agent.id, { id:"persisted-goal", type:"set_goal", goal:"Build a northern relay camp" }).accepted, true);
  const restored = new WorldRuntime({ state:runtime.snapshot(), pendingCommands:runtime.pendingCommands() });
  restored.tick();
  assert.equal(restored.snapshot().agents.find((entry)=>entry.id===agent.id)?.goal, "Build a northern relay camp");
});

test("trade is atomic", () => {
  const state=createInitialWorld({seed:42}), seller=state.agents[0], buyer=state.agents[1]; assert.ok(seller); assert.ok(buyer);
  buyer.position={...seller.position}; seller.inventory={wood:5,stone:0,food:0}; buyer.inventory={wood:0,stone:3,food:0};
  const result=simulate(state,[{id:"trade-test",agentId:seller.id,submittedAtTick:state.tick,type:"trade",targetAgentId:buyer.id,offer:{wood:2,stone:0,food:0},request:{wood:0,stone:1,food:0}}]);
  assert.equal(result.receipts[0]?.accepted,true);
  assert.deepEqual(result.state.agents.find((entry)=>entry.id===seller.id)?.inventory,{wood:3,stone:1,food:0});
  assert.deepEqual(result.state.agents.find((entry)=>entry.id===buyer.id)?.inventory,{wood:2,stone:2,food:0});
  assert.deepEqual(emptyInventory(),{wood:0,stone:0,food:0});
});

test("low-energy autonomous agents eat carried food before resuming work", () => {
  const state = createInitialWorld({ seed: 2026 });
  const agent = state.agents[0]; assert.ok(agent);
  agent.energy = 10;
  agent.inventory.food = 1;
  delete agent.task;

  const runtime = new WorldRuntime({ state });
  const next = runtime.tick().state;
  const rested = next.agents.find((entry) => entry.id === agent.id); assert.ok(rested);

  assert.equal(rested.inventory.food, 0);
  assert.equal(rested.energy, 45);
  assert.equal(rested.status, "resting after a meal");
  assert.equal(rested.autonomy, true);
  assert.equal(rested.task, undefined);
});

test("hungry autonomous agents accept surplus food from a nearby ally", () => {
  const state = createInitialWorld({ seed: 2027 });
  const hungry = state.agents[0]; assert.ok(hungry);
  const donor = state.agents[1]; assert.ok(donor);
  assert.equal(hungry.factionId, donor.factionId);

  hungry.energy = 10;
  hungry.inventory.food = 0;
  delete hungry.task;
  donor.position = { ...hungry.position };
  donor.energy = 90;
  donor.inventory.food = 2;
  delete donor.task;

  const runtime = new WorldRuntime({ state });
  const next = runtime.tick().state;
  const rested = next.agents.find((entry) => entry.id === hungry.id); assert.ok(rested);
  const sharedBy = next.agents.find((entry) => entry.id === donor.id); assert.ok(sharedBy);

  assert.equal(rested.inventory.food, 0);
  assert.equal(rested.energy, 45);
  assert.equal(sharedBy.inventory.food, 1);
  assert.equal(rested.status, `resting after ${donor.name} shared food`);
  assert.equal(rested.task, undefined);
});

test("prolonged starvation can reduce a faction's population", () => {
  const state = createInitialWorld({ seed: 2028 });
  const doomed = state.agents[0]; assert.ok(doomed);
  const initialPopulation = state.agents.length;

  for (const agent of state.agents) agent.inventory.food = 0;
  for (const faction of state.factions) faction.resources.food = 0;
  for (const tile of state.tiles) {
    if (tile.resource?.kind === "food") tile.resource.amount = 0;
  }
  for (const structure of state.structures) structure.storage.food = 0;

  doomed.energy = 0;
  doomed.hp = 2;
  delete doomed.task;

  const runtime = new WorldRuntime({ state });
  const first = runtime.tick().state;
  const starving = first.agents.find((entry) => entry.id === doomed.id); assert.ok(starving);
  assert.equal(starving.hp, 1);
  assert.match(starving.status, /^starving;/);

  const second = runtime.tick().state;
  assert.equal(second.agents.some((entry) => entry.id === doomed.id), false);
  assert.equal(second.agents.length, initialPopulation - 1);
});

test("food-secure settlements can grow their population when local space is available", () => {
  const state = createInitialWorld({ seed: 2029 });
  const faction = state.factions.find((entry) => entry.id === "ember"); assert.ok(faction);
  const members = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(members.length >= 2);
  const originalIds = new Set(members.map((agent) => agent.id));
  const campPosition = { ...members[0].position };

  faction.resources.food = 40;
  state.structures.push({
    id: "population-growth-camp",
    factionId: faction.id,
    type: "camp",
    position: campPosition,
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 40 },
  });
  for (const member of members) {
    member.hp = 100;
    member.energy = 100;
    delete member.task;
  }
  state.tick = 59;

  const runtime = new WorldRuntime({ state });
  const next = runtime.tick().state;
  const nextFaction = next.factions.find((entry) => entry.id === faction.id); assert.ok(nextFaction);
  const nextMembers = next.agents.filter((agent) => agent.factionId === faction.id);
  const newcomer = nextMembers.find((agent) => !originalIds.has(agent.id)); assert.ok(newcomer);
  const camp = next.structures.find((structure) => structure.id === "population-growth-camp"); assert.ok(camp);

  assert.equal(nextMembers.length, members.length + 1);
  assert.equal(nextFaction.resources.food, 34);
  assert.equal(camp.storage.food, 34);
  assert.equal(newcomer.status, "new generation settling");
  assert.ok(Math.abs(newcomer.position.x - campPosition.x) + Math.abs(newcomer.position.y - campPosition.y) <= 3);
});
