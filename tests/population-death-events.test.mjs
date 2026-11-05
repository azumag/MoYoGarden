import assert from "node:assert/strict";
import test from "node:test";
import {
  POPULATION_BASAL_FOOD_INTERVAL_TICKS,
  POPULATION_ELDER_AGE_TICKS,
  applyPopulationAging,
  applyPopulationMaintenance,
  naturalLifespanTicks,
} from "../dist-ts/src/demography.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function adultWithBirth(state, birthTick, id = "death-test-agent") {
  const base = structuredClone(state.agents[0]);
  assert.ok(base);
  base.id = id;
  base.name = "Death Test";
  base.factionId = state.factions[0].id;
  base.hp = 100;
  base.energy = 100;
  base.autonomy = false;
  base.birthTick = birthTick;
  base.lifeStage = "adult";
  delete base.task;
  delete base.pregnancy;
  return base;
}

test("natural lifespan death emits agent_died with cause and position", () => {
  const state = createInitialWorld({ seed: 39039 });
  const agent = adultWithBirth(state, 0, "lifespan-victim");
  agent.position = { x: 3, y: 4 };
  agent.heritableTraits = { vitality: 1, carryingCapacity: 1 };
  state.agents = [agent];
  state.tick = naturalLifespanTicks(agent.id, 1);

  applyPopulationAging(state);

  assert.equal(state.agents.some((entry) => entry.id === agent.id), false);
  const death = state.events.find((event) => event.kind === "agent_died" && event.agentId === agent.id);
  assert.ok(death, "expected agent_died event");
  assert.equal(death.tick, state.tick);
  assert.equal(death.factionId, agent.factionId);
  assert.deepEqual(death.position, { x: 3, y: 4 });
  assert.equal(death.data?.cause, "natural_lifespan");
  assert.equal(death.data?.deathTick, state.tick);
  assert.deepEqual(death.data?.position, { x: 3, y: 4 });
});

test("basal food deficit death emits agent_died", () => {
  const state = createInitialWorld({ seed: 39040 });
  const faction = state.factions[0];
  assert.ok(faction);
  faction.resources.food = 0;
  for (const structure of state.structures) structure.storage.food = 0;

  const agent = adultWithBirth(state, 0, "basal-victim");
  agent.factionId = faction.id;
  agent.position = { x: 5, y: 6 };
  agent.hp = 1; // one basal hunger health cost kills
  agent.energy = 10;
  state.agents = [agent];
  state.tick = POPULATION_BASAL_FOOD_INTERVAL_TICKS;

  applyPopulationMaintenance(state);

  assert.equal(state.agents.length, 0);
  const death = state.events.find((event) => event.kind === "agent_died" && event.agentId === agent.id);
  assert.ok(death);
  assert.equal(death.data?.cause, "basal_food_deficit");
  assert.deepEqual(death.position, { x: 5, y: 6 });
});

test("runtime starvation death emits agent_died", () => {
  const state = createInitialWorld({ seed: 39041 });
  const faction = state.factions[0];
  assert.ok(faction);
  faction.resources.food = 0;
  for (const structure of state.structures) structure.storage.food = 0;
  for (const tile of state.tiles) if (tile.resource?.kind === "food") tile.resource.amount = 0;

  const agent = adultWithBirth(state, undefined, "starve-victim");
  agent.factionId = faction.id;
  agent.position = { x: 7, y: 8 };
  agent.hp = 1;
  agent.energy = 0;
  agent.autonomy = true;
  state.agents = [agent];

  const runtime = new WorldRuntime({ state });
  runtime.tick();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.agents.some((entry) => entry.id === agent.id), false);
  const death = snapshot.events.find(
    (event) => event.kind === "agent_died" && event.agentId === agent.id,
  );
  assert.ok(death);
  assert.equal(death.data?.cause, "starvation");
  assert.equal(death.tick, snapshot.tick);
  assert.equal(death.data?.deathTick, snapshot.tick);
  assert.ok(death.position && Number.isInteger(death.position.x) && Number.isInteger(death.position.y));
  assert.deepEqual(death.data?.position, death.position);
});

test("tick reports births and deaths for the current tick", () => {
  const state = createInitialWorld({ seed: 39042 });
  const agent = adultWithBirth(state, 0, "stats-victim");
  agent.hp = 1;
  agent.energy = 0;
  agent.autonomy = true;
  const faction = state.factions.find((entry) => entry.id === agent.factionId);
  assert.ok(faction);
  faction.resources.food = 0;
  for (const structure of state.structures) structure.storage.food = 0;
  for (const tile of state.tiles) if (tile.resource?.kind === "food") tile.resource.amount = 0;
  state.agents = [agent];

  const runtime = new WorldRuntime({ state });
  const result = runtime.tick();
  assert.equal(typeof result.births, "number");
  assert.equal(typeof result.deaths, "number");
  assert.ok(result.deaths >= 1);
});
