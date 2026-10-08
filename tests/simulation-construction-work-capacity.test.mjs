import assert from "node:assert/strict";
import test from "node:test";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const emptyInventory = () => ({ wood: 0, stone: 0, food: 0 });
const SITE = { x: 7, y: 5 };

function crewFixture(type, crewSize) {
  const state = createInitialWorld({ seed: 3907, width: 16, height: 12 });
  for (const tile of state.tiles) {
    if (tile.terrain !== "water") tile.terrain = "plain";
    delete tile.resource;
  }

  const template = state.agents.find((agent) => agent.role === "builder");
  assert.ok(template);

  const builders = [];
  for (let index = 0; index < crewSize; index += 1) {
    const builder = structuredClone(template);
    builder.id = `crew-builder-${index + 1}`;
    builder.name = `Crew Builder ${index + 1}`;
    builder.position = { ...SITE };
    builder.hp = 100;
    builder.energy = 100;
    builder.inventory = emptyInventory();
    builder.autonomy = false;
    builder.task = {
      source: "external",
      issuedAtTick: state.tick,
      type: "build",
      structureType: type,
      structureId: `${type}-under-construction`,
      target: { ...SITE },
    };
    builders.push(builder);
  }
  state.agents = builders;

  state.structures = [{
    id: `${type}-under-construction`,
    factionId: template.factionId,
    type,
    position: { ...SITE },
    status: "building",
    progress: 0,
    requiredProgress: BUILD_RECIPES[type].work,
    storage: emptyInventory(),
  }];
  state.events = [];
  state.processedCommandIds = [];
  return state;
}

function structureById(state, id) {
  const structure = state.structures.find((candidate) => candidate.id === id);
  assert.ok(structure, `expected ${id} to exist`);
  return structure;
}

test("a crew larger than a camp's work capacity cannot advance construction faster", () => {
  const capacity = BUILD_RECIPES.camp.workCapacity;
  assert.equal(capacity, 2);

  const state = crewFixture("camp", 3);
  const next = simulate(state).state;
  const camp = structureById(next, "camp-under-construction");
  assert.equal(camp.status, "building");
  assert.equal(
    camp.progress,
    capacity,
    "one tick should absorb exactly the camp's work capacity, not every builder's effort",
  );

  const working = next.agents.filter((agent) => agent.status.startsWith("building camp "));
  const waiting = next.agents.filter((agent) => agent.status === "waiting for camp work capacity");
  assert.equal(working.length, capacity);
  assert.equal(waiting.length, 3 - capacity);

  for (const agent of next.agents) {
    assert.equal(agent.task?.type, "build", "throttled builders must keep their construction intent");
    assert.equal(agent.task?.structureId, camp.id);
  }
  for (const agent of working) assert.equal(agent.energy, 98);
  for (const agent of waiting) {
    assert.equal(agent.energy, 100, "waiting for work capacity must not burn energy for unusable work");
  }
});

test("work capacity is a per-building-type property, not a global crew limit", () => {
  assert.ok(BUILD_RECIPES.workshop.workCapacity > BUILD_RECIPES.camp.workCapacity);

  const camp = structureById(simulate(crewFixture("camp", 3)).state, "camp-under-construction");
  const workshop = structureById(
    simulate(crewFixture("workshop", 3)).state,
    "workshop-under-construction",
  );

  assert.equal(camp.progress, BUILD_RECIPES.camp.workCapacity);
  assert.equal(
    workshop.progress,
    3,
    "a workshop with a larger work capacity should absorb the whole three-builder crew",
  );

  const workshopState = crewFixture("workshop", 3);
  const next = simulate(workshopState).state;
  assert.equal(
    next.agents.filter((agent) => agent.status.startsWith("waiting for ")).length,
    0,
    "a crew within the work capacity must never be throttled",
  );
});

test("a crew within the work capacity still advances one step per builder", () => {
  const next = simulate(crewFixture("camp", 2)).state;
  const camp = structureById(next, "camp-under-construction");
  assert.equal(camp.progress, 2);
  assert.equal(next.agents.filter((agent) => agent.status.startsWith("building camp ")).length, 2);
  assert.equal(next.agents.filter((agent) => agent.status.startsWith("waiting for ")).length, 0);
});

test("an over-capacity crew still finishes the structure on later ticks", () => {
  const capacity = BUILD_RECIPES.camp.workCapacity;
  const requiredProgress = BUILD_RECIPES.camp.work;
  const expectedTicks = Math.ceil(requiredProgress / capacity);

  let state = crewFixture("camp", 3);
  let camp = structureById(state, "camp-under-construction");
  let ticks = 0;
  while (camp.status === "building" && ticks < expectedTicks + 2) {
    state = simulate(state).state;
    camp = structureById(state, "camp-under-construction");
    ticks += 1;
  }

  assert.equal(camp.status, "active", "throttling must not stall the structure");
  assert.equal(camp.progress, requiredProgress);
  assert.equal(ticks, expectedTicks);
});
