import assert from "node:assert/strict";
import test from "node:test";
import { emptyInventory, manhattanDistance } from "../dist-ts/src/protocol.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import {
  applyTerrainErosion,
  drainageAt,
  flowTargetAt,
  resourceRegrowthChance,
  simulate,
  surfaceMoistureAt,
  terrainErosionPressureAt,
  updateTileHydrology,
} from "../dist-ts/src/simulation.js";
import { createInitialWorld, getPerception, validateWorldState } from "../dist-ts/src/world.js";

function advance(initial, ticks) {
  let state = initial;
  for (let index = 0; index < ticks; index += 1) state = simulate(state).state;
  return state;
}

test("same seed produces the same world", () => {
  assert.deepEqual(advance(createInitialWorld({ seed: 123456 }), 160), advance(createInitialWorld({ seed: 123456 }), 160));
});

test("continuous elevation is observable, backfilled, and affects lowland moisture", () => {
  const state = createInitialWorld({ seed: 3031, width: 16, height: 12 });
  assert.ok(state.tiles.every((tile) => Number.isFinite(tile.elevation) && tile.elevation >= 0 && tile.elevation <= 1));
  assert.ok(state.tiles.filter((tile) => tile.terrain === "water").every((tile) => tile.elevation === 0));

  const target = state.tiles.find((tile) => tile.x === 8 && tile.y === 6); assert.ok(target);
  for (const tile of state.tiles) {
    if (tile.terrain === "water") tile.terrain = "plain";
  }
  target.terrain = "plain";
  delete target.resource;
  target.elevation = 0.1;
  const lowlandMoisture = surfaceMoistureAt(state, target);
  target.elevation = 0.9;
  const highlandMoisture = surfaceMoistureAt(state, target);
  assert.ok(lowlandMoisture > highlandMoisture);

  const legacy = createInitialWorld({ seed: 3032, width: 16, height: 12 });
  for (const tile of legacy.tiles) {
    delete tile.elevation;
    delete tile.flowTo;
    delete tile.drainage;
    delete tile.erosionPressure;
  }
  const upgraded = simulate(legacy).state;
  assert.ok(upgraded.tiles.every((tile) => Number.isFinite(tile.elevation)));
  assert.ok(upgraded.tiles.every((tile) => Number.isFinite(tile.drainage) && tile.drainage >= 0 && tile.drainage <= 1));
  assert.ok(upgraded.tiles.every((tile) => Number.isFinite(tile.erosionPressure) && tile.erosionPressure >= 0 && tile.erosionPressure <= 1));
});

test("downhill flow accumulates drainage and feeds organic regrowth", () => {
  const state = createInitialWorld({ seed: 3033, width: 16, height: 12 });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    tile.elevation = 0.95;
    delete tile.resource;
    delete tile.flowTo;
    delete tile.drainage;
    delete tile.erosionPressure;
  }

  const y = 6;
  for (let x = 3; x <= 9; x += 1) {
    const tile = state.tiles.find((entry) => entry.x === x && entry.y === y); assert.ok(tile);
    tile.elevation = 0.8 - (x - 3) * 0.1;
  }
  const outlet = state.tiles.find((tile) => tile.x === 10 && tile.y === y); assert.ok(outlet);
  outlet.terrain = "water";
  outlet.elevation = 0;

  updateTileHydrology(state);
  const head = state.tiles.find((tile) => tile.x === 3 && tile.y === y); assert.ok(head);
  const channel = state.tiles.find((tile) => tile.x === 9 && tile.y === y); assert.ok(channel);
  assert.deepEqual(flowTargetAt(state, head), { x: 4, y });
  assert.deepEqual(channel.flowTo, { x: 10, y });
  assert.ok(drainageAt(state, channel) > drainageAt(state, head));

  head.resource = { kind: "food", amount: 0, maxAmount: 10 };
  channel.resource = { kind: "food", amount: 0, maxAmount: 10 };
  assert.ok(surfaceMoistureAt(state, channel) > surfaceMoistureAt(state, head));
  assert.ok(resourceRegrowthChance(state, channel) > resourceRegrowthChance(state, head));

  const observer = state.agents[0]; assert.ok(observer);
  const perception = getPerception(state, observer.id, 12);
  const visibleChannel = perception.visibleTiles.find((tile) => tile.x === channel.x && tile.y === channel.y); assert.ok(visibleChannel);
  assert.equal(visibleChannel.drainage, channel.drainage);
  assert.equal(visibleChannel.erosionPressure, channel.erosionPressure);
  assert.deepEqual(visibleChannel.flowTo, channel.flowTo);
});

test("drainage-driven erosion moves sediment downhill while vegetation protects soil", () => {
  const state = createInitialWorld({ seed: 3034, width: 16, height: 12 });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    tile.elevation = 0.4;
    delete tile.resource;
    delete tile.flowTo;
    tile.drainage = 0;
    tile.erosionPressure = 0;
  }

  const source = state.tiles.find((tile) => tile.x === 7 && tile.y === 6); assert.ok(source);
  const target = state.tiles.find((tile) => tile.x === 8 && tile.y === 6); assert.ok(target);
  source.elevation = 0.6;
  target.elevation = 0.4;
  source.flowTo = { x: target.x, y: target.y };
  source.drainage = 1;
  source.resource = { kind: "wood", amount: 0, maxAmount: 10 };

  const barePressure = terrainErosionPressureAt(state, source);
  source.resource.amount = 10;
  const protectedPressure = terrainErosionPressureAt(state, source);
  assert.ok(barePressure > protectedPressure);

  source.resource.amount = 0;
  source.erosionPressure = barePressure;
  const sourceBefore = source.elevation;
  const targetBefore = target.elevation;
  const pairBefore = sourceBefore + targetBefore;
  const moved = applyTerrainErosion(state);

  assert.ok(moved > 0);
  assert.ok(source.elevation < sourceBefore);
  assert.ok(target.elevation > targetBefore);
  assert.ok(Math.abs((source.elevation + target.elevation) - pairBefore) < 1e-12);
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

test("perception remains local on the hex metric", () => {
  const state = createInitialWorld({ seed: 777 });
  const self = state.agents.find((agent) => agent.factionId === "ember");
  assert.ok(self);
  const perception = getPerception(state, self.id, 2);
  assert.equal(perception.radius, 2);
  assert.ok(perception.visibleTiles.length < state.tiles.length);
  assert.ok(perception.visibleTiles.every((tile) => manhattanDistance(tile, self.position) <= 2));
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


test("conception is not directly gated by settlement food stock", () => {
  const state = createInitialWorld({ seed: 2030 });
  const faction = state.factions.find((entry) => entry.id === "ember"); assert.ok(faction);
  const members = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(members.length >= 2);
  const parent = members[0]; assert.ok(parent);
  const partner = members[1]; assert.ok(partner);

  faction.resources.food = 0;
  for (const structure of state.structures) {
    if (structure.factionId === faction.id) structure.storage.food = 0;
  }
  const extraCamps = Math.ceil((members.length + 1) / 6) + 1;
  for (let index = 0; index < extraCamps; index += 1) {
    state.structures.push({
      id: `food-independent-conception-camp-${index}`,
      factionId: faction.id,
      type: "camp",
      position: { ...parent.position },
      status: "active",
      progress: 6,
      requiredProgress: 6,
      storage: { wood: 0, stone: 0, food: 0 },
    });
  }
  for (const member of members) {
    member.hp = 100;
    member.energy = 100;
    member.autonomy = false;
    member.reproductiveRole = member.id === parent.id ? "gestational" : "partner";
    delete member.pregnancy;
    delete member.lastBirthTick;
    delete member.socialMemory;
    delete member.task;
  }
  parent.socialMemory = [{ agentId: partner.id, familiarity: 3, lastInteractionTick: 1 }];
  partner.socialMemory = [{ agentId: parent.id, familiarity: 3, lastInteractionTick: 1 }];
  partner.position = { ...parent.position };
  state.tick = 8_639;

  const conceived = new WorldRuntime({ state }).tick().state;
  const conceivedParent = conceived.agents.find((entry) => entry.id === parent.id); assert.ok(conceivedParent);
  assert.equal(conceivedParent.pregnancy?.partnerId, partner.id);
});

test("conception is not directly gated by settlement resident capacity", () => {
  const state = createInitialWorld({ seed: 2031 });
  const faction = state.factions.find((entry) => entry.id === "ember"); assert.ok(faction);
  const members = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(members.length >= 2);
  const parent = members[0]; assert.ok(parent);
  const partner = members[1]; assert.ok(partner);

  // Make housing exactly full while keeping the biological pair healthy.
  // Housing pressure should drive camp expansion / migration elsewhere in
  // the simulation, not act as a direct fertility switch.
  state.structures = state.structures.filter((structure) =>
    structure.factionId !== faction.id || structure.type !== "camp"
  );
  const targetPopulation = Math.ceil(members.length / 6) * 6;
  const campCount = targetPopulation / 6;
  const occupied = new Set(state.structures.map((structure) =>
    `${structure.position.x},${structure.position.y}`
  ));
  const campSites = state.tiles
    .filter((tile) => tile.terrain !== "water" && !occupied.has(`${tile.x},${tile.y}`))
    .slice(0, campCount);
  assert.equal(campSites.length, campCount);
  for (let index = 0; index < campCount; index += 1) {
    const site = campSites[index]; assert.ok(site);
    state.structures.push({
      id: `housing-full-camp-${index}`,
      factionId: faction.id,
      type: "camp",
      position: { x: site.x, y: site.y },
      status: "active",
      progress: 6,
      requiredProgress: 6,
      storage: { wood: 0, stone: 0, food: 100 },
    });
  }
  faction.resources.food = 100;

  for (const member of members) {
    member.hp = 100;
    member.energy = 100;
    member.autonomy = false;
    member.reproductiveRole = member.id === parent.id ? "gestational" : "partner";
    delete member.pregnancy;
    delete member.lastBirthTick;
    delete member.socialMemory;
    delete member.task;
  }
  for (let index = members.length; index < targetPopulation; index += 1) {
    const resident = structuredClone(partner);
    resident.id = `housing-full-resident-${index}`;
    resident.name = `Housing Resident ${index}`;
    resident.hp = 100;
    resident.energy = 100;
    resident.autonomy = false;
    resident.reproductiveRole = "partner";
    resident.socialMemory = [];
    delete resident.pregnancy;
    delete resident.lastBirthTick;
    delete resident.task;
    state.agents.push(resident);
  }
  parent.socialMemory = [{ agentId: partner.id, familiarity: 3, lastInteractionTick: 1 }];
  partner.socialMemory = [{ agentId: parent.id, familiarity: 3, lastInteractionTick: 1 }];
  partner.position = { ...parent.position };
  assert.equal(
    state.agents.filter((agent) => agent.factionId === faction.id).length,
    campCount * 6,
  );
  state.tick = 8_639;

  const conceived = new WorldRuntime({ state }).tick().state;
  const conceivedParent = conceived.agents.find((entry) => entry.id === parent.id); assert.ok(conceivedParent);
  assert.equal(conceivedParent.pregnancy?.partnerId, partner.id);
});

test("population growth requires conception, gestation, and biological parentage", () => {
  const state = createInitialWorld({ seed: 2029 });
  const faction = state.factions.find((entry) => entry.id === "ember"); assert.ok(faction);
  const members = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(members.length >= 2);
  const originalIds = new Set(members.map((agent) => agent.id));
  const parent = members[0]; assert.ok(parent);
  const partner = members[1]; assert.ok(partner);
  const campPosition = { ...parent.position };

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
    member.reproductiveRole = member.id === parent.id ? "gestational" : "partner";
    delete member.pregnancy;
    delete member.lastBirthTick;
    delete member.socialMemory;
    delete member.task;
  }
  parent.socialMemory = [{ agentId: partner.id, familiarity: 3, lastInteractionTick: 1 }];
  partner.socialMemory = [{ agentId: parent.id, familiarity: 3, lastInteractionTick: 1 }];
  partner.position = { ...parent.position };
  state.tick = 8_639;

  const conceived = new WorldRuntime({ state }).tick().state;
  const conceivedParent = conceived.agents.find((entry) => entry.id === parent.id); assert.ok(conceivedParent);
  assert.equal(conceived.agents.filter((agent) => agent.factionId === faction.id).length, members.length);
  assert.equal(conceivedParent.pregnancy?.partnerId, partner.id);
  assert.equal(conceivedParent.pregnancy?.conceivedAtTick, 8_640);
  assert.equal(conceivedParent.pregnancy?.dueAtTick, 17_280);
  assert.equal(
    conceived.factions.find((entry) => entry.id === faction.id)?.resources.food,
    40 - members.length,
  );

  conceived.tick = 17_279;
  const born = new WorldRuntime({ state: conceived }).tick().state;
  const nextMembers = born.agents.filter((agent) => agent.factionId === faction.id);
  const newcomer = nextMembers.find((agent) => !originalIds.has(agent.id)); assert.ok(newcomer);
  const camp = born.structures.find((structure) => structure.id === "population-growth-camp"); assert.ok(camp);

  assert.equal(nextMembers.length, members.length + 1);
  const expectedFoodAfterBirth = 40 - members.length * 2 - 6;
  assert.equal(born.factions.find((entry) => entry.id === faction.id)?.resources.food, expectedFoodAfterBirth);
  assert.equal(camp.storage.food, expectedFoodAfterBirth);
  const birthParent = born.agents.find((entry) => entry.id === parent.id); assert.ok(birthParent);
  assert.equal(newcomer.lifeStage, "infant");
  assert.equal(newcomer.autonomy, false);
  assert.deepEqual(newcomer.parents, [parent.id, partner.id]);
  assert.deepEqual(newcomer.position, birthParent.position);

  born.tick = 25_919;
  const juvenile = new WorldRuntime({ state: born }).tick().state.agents.find((entry) => entry.id === newcomer.id);
  assert.ok(juvenile);
  assert.equal(juvenile.lifeStage, "juvenile");
  assert.equal(juvenile.autonomy, false);

  born.tick = 43_199;
  const adult = new WorldRuntime({ state: born }).tick().state.agents.find((entry) => entry.id === newcomer.id);
  assert.ok(adult);
  assert.equal(adult.lifeStage, "adult");
  assert.equal(adult.autonomy, true);
});

test("dead residents do not trigger autonomous housing expansion", () => {
  const state = createInitialWorld({ seed: 2031 });
  const builder = state.agents.find((agent) => agent.role === "builder"); assert.ok(builder);
  const faction = state.factions.find((entry) => entry.id === builder.factionId); assert.ok(faction);
  const residents = [builder, ...state.agents.filter((agent) => agent.id !== builder.id).slice(0, 6)];
  assert.equal(residents.length, 7);
  for (const [index, agent] of residents.entries()) {
    agent.factionId = builder.factionId;
    agent.hp = index < 5 ? 100 : 0;
    agent.energy = 100;
    agent.autonomy = agent.id === builder.id;
    delete agent.task;
  }
  state.agents = residents;
  faction.resources = { wood: 100, stone: 100, food: 100 };

  const position = { ...builder.position };
  state.structures = [
    {
      id: "living-pressure-camp",
      factionId: builder.factionId,
      type: "camp",
      position,
      status: "active",
      progress: 6,
      requiredProgress: 6,
      storage: { wood: 0, stone: 0, food: 0 },
    },
    ...["storehouse", "market", "workshop"].map((type, index) => ({
      id: `living-pressure-${type}`,
      factionId: builder.factionId,
      type,
      position: { x: position.x + index + 1, y: position.y },
      status: "active",
      progress: 20,
      requiredProgress: 1,
      storage: { wood: 0, stone: 0, food: 0 },
    })),
  ];

  const next = simulate(state).state;
  const nextBuilder = next.agents.find((agent) => agent.id === builder.id); assert.ok(nextBuilder);
  assert.notEqual(
    nextBuilder.task?.type === "build" && nextBuilder.task.structureType === "camp",
    true,
    "only living residents should create housing expansion pressure",
  );
});
