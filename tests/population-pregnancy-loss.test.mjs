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
import { detachAgentOwnership } from "../dist-ts/src/agent-ownership.js";

function pregnantFixture({ seed, dueAtTick, food = 0 }) {
  const state = createInitialWorld({ seed });
  const faction = state.factions[0];
  assert.ok(faction);
  const templates = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(templates.length >= 2);
  const parent = structuredClone(templates[0]);
  const partner = structuredClone(templates[1]);
  parent.id = "loss-parent";
  parent.name = "Loss Parent";
  partner.id = "loss-partner";
  partner.name = "Loss Partner";
  for (const agent of [parent, partner]) {
    agent.factionId = faction.id;
    agent.hp = 100;
    agent.energy = 100;
    agent.autonomy = false;
    agent.lifeStage = "adult";
    agent.birthTick = 0;
    delete agent.task;
    delete agent.pregnancy;
    delete agent.lastBirthTick;
  }
  parent.reproductiveRole = "gestational";
  partner.reproductiveRole = "partner";
  parent.heritableTraits = { vitality: 1, carryingCapacity: 1 };
  partner.heritableTraits = { vitality: 1.1, carryingCapacity: 1.05 };
  parent.pregnancy = {
    partnerId: partner.id,
    conceivedAtTick: 0,
    dueAtTick,
    partnerTraits: { ...partner.heritableTraits },
  };

  state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
  state.agents.push(parent, partner);
  state.structures = state.structures.filter((structure) => structure.factionId !== faction.id);
  state.structures.push({
    id: "loss-storehouse",
    factionId: faction.id,
    type: "storehouse",
    position: { ...parent.position },
    status: "active",
    progress: 10,
    requiredProgress: 10,
    storage: { wood: 0, stone: 0, food },
  });
  faction.resources.food = food;
  return { state, faction, parent, partner };
}

function pregnancyLossEvents(state) {
  return state.events.filter((event) => event.kind === "pregnancy_lost");
}

test("lifespan death of a pregnant parent emits one pregnancy_lost with gestation context", () => {
  const lifespan = naturalLifespanTicks("loss-parent", 1);
  const dueAtTick = lifespan + 1_000;
  const { state, parent, partner } = pregnantFixture({ seed: 9_900, dueAtTick });
  state.tick = lifespan;
  partner.birthTick = lifespan - 100;

  applyPopulationAging(state);

  assert.equal(state.agents.some((agent) => agent.id === parent.id), false);
  assert.ok(state.agents.some((agent) => agent.id === partner.id), "partner survives");

  const losses = pregnancyLossEvents(state);
  assert.equal(losses.length, 1);
  const [loss] = losses;
  assert.equal(loss.agentId, parent.id);
  assert.equal(loss.factionId, parent.factionId);
  assert.equal(loss.tick, lifespan);
  assert.equal(loss.data?.outcome, "gestational_parent_died");
  assert.equal(loss.data?.parentId, parent.id);
  assert.equal(loss.data?.partnerId, partner.id);
  assert.equal(loss.data?.conceivedAtTick, 0);
  assert.equal(loss.data?.dueAtTick, dueAtTick);
  assert.equal(loss.data?.gestationElapsedTicks, lifespan);
  assert.equal(loss.data?.parentDeathCause, "natural_lifespan");
  assert.equal(loss.data?.deathTick, lifespan);
  assert.deepEqual(loss.data?.position, parent.position);

  const deaths = state.events.filter((event) => event.kind === "agent_died");
  assert.equal(deaths.length, 1);
  const ordered = state.events
    .filter((event) => event.kind === "agent_died" || event.kind === "pregnancy_lost")
    .map((event) => event.kind);
  assert.deepEqual(ordered, ["agent_died", "pregnancy_lost"], "death precedes its consequence");
  assert.equal(state.agents.some((agent) => agent.birthTick === state.tick), false);
});

test("basal food deficit death of a pregnant parent emits pregnancy_lost", () => {
  const { state, parent, partner } = pregnantFixture({
    seed: 9_901,
    dueAtTick: POPULATION_BASAL_FOOD_INTERVAL_TICKS * 2,
  });
  parent.hp = 1;
  partner.hp = 100;
  state.tick = POPULATION_BASAL_FOOD_INTERVAL_TICKS;

  applyPopulationMaintenance(state);

  assert.equal(state.agents.some((agent) => agent.id === parent.id), false);
  const losses = pregnancyLossEvents(state);
  assert.equal(losses.length, 1);
  assert.equal(losses[0].data?.parentDeathCause, "basal_food_deficit");
  assert.equal(losses[0].data?.gestationElapsedTicks, POPULATION_BASAL_FOOD_INTERVAL_TICKS);
});

test("runtime starvation death of a pregnant parent emits pregnancy_lost and keeps deaths at one", () => {
  const { state, faction, parent, partner } = pregnantFixture({ seed: 9_902, dueAtTick: 50_000 });
  for (const tile of state.tiles) if (tile.resource?.kind === "food") tile.resource.amount = 0;
  for (const structure of state.structures) structure.storage.food = 0;
  faction.resources.food = 0;
  parent.hp = 1;
  parent.energy = 0;
  parent.autonomy = true;
  delete parent.task;
  partner.autonomy = false;
  state.tick = 100;

  const runtime = new WorldRuntime({ state });
  const result = runtime.tick();
  const snapshot = runtime.snapshot();

  assert.equal(snapshot.agents.some((agent) => agent.id === parent.id), false);
  const losses = pregnancyLossEvents(snapshot);
  assert.equal(losses.length, 1);
  assert.equal(losses[0].data?.parentDeathCause, "starvation");
  assert.equal(losses[0].tick, snapshot.tick);
  assert.equal(result.deaths, 1, "pregnancy loss is not a population death");
});

test("a parent dying on the due tick produces a pregnancy loss instead of a birth", () => {
  const { state, faction, parent, partner } = pregnantFixture({ seed: 9_903, dueAtTick: 8_640 });
  for (const tile of state.tiles) if (tile.resource?.kind === "food") tile.resource.amount = 0;
  for (const structure of state.structures) structure.storage.food = 0;
  faction.resources.food = 0;
  parent.hp = 1;
  parent.energy = 0;
  parent.autonomy = true;
  partner.autonomy = false;
  delete parent.task;
  state.tick = 8_639;

  const runtime = new WorldRuntime({ state });
  const result = runtime.tick();
  const snapshot = runtime.snapshot();

  assert.equal(snapshot.tick, 8_640);
  assert.equal(result.births, 0);
  assert.equal(result.deaths, 1);
  assert.equal(pregnancyLossEvents(snapshot).length, 1);
  assert.equal(
    snapshot.agents.some((agent) => Array.isArray(agent.parents) && agent.parents[0] === parent.id),
    false,
    "no child is created for a gestation that ended at its due tick",
  );
  assert.equal(pregnancyLossEvents(snapshot)[0].data?.gestationElapsedTicks, 8_640);
});

test("partner death does not end the gestation and birth inherits snapshot traits", () => {
  const dueAtTick = 8_640;
  const { state, parent, partner } = pregnantFixture({ seed: 9_904, dueAtTick, food: 200 });
  partner.birthTick = 0;
  state.tick = naturalLifespanTicks(partner.id, partner.heritableTraits?.vitality ?? 1);

  applyPopulationAging(state);

  assert.equal(state.agents.some((agent) => agent.id === partner.id), false);
  assert.equal(pregnancyLossEvents(state).length, 0);
  assert.equal(state.agents.find((agent) => agent.id === parent.id)?.pregnancy?.partnerId, partner.id);

  state.tick = dueAtTick - 1;
  const runtime = new WorldRuntime({ state });
  runtime.tick();
  const snapshot = runtime.snapshot();
  const newborn = snapshot.agents.find(
    (agent) => Array.isArray(agent.parents) && agent.parents[0] === parent.id,
  );
  assert.ok(newborn, "birth proceeds without the partner");
  assert.deepEqual(newborn.parents, [parent.id, partner.id]);
  assert.equal(pregnancyLossEvents(snapshot).length, 0);
});

test("elder transition keeps an existing gestation and only death ends it", () => {
  const { state, parent } = pregnantFixture({
    seed: 9_905,
    dueAtTick: POPULATION_ELDER_AGE_TICKS + 500,
    food: 100,
  });
  state.tick = POPULATION_ELDER_AGE_TICKS;

  applyPopulationAging(state);

  const elder = state.agents.find((agent) => agent.id === parent.id);
  assert.ok(elder);
  assert.equal(elder.lifeStage, "elder");
  assert.ok(elder.pregnancy);
  assert.equal(pregnancyLossEvents(state).length, 0);
});

test("region handoff preserves gestation without emitting pregnancy_lost and promotes the partner id", () => {
  const { state, parent, partner } = pregnantFixture({ seed: 9_906, dueAtTick: 40_000 });
  state.events.push({
    id: "event-prior-loss-1",
    tick: 10,
    kind: "pregnancy_lost",
    message: "prior loss",
    agentId: "agent-elsewhere",
    factionId: parent.factionId,
    position: { ...parent.position },
    data: {
      outcome: "gestational_parent_died",
      parentId: "agent-elsewhere",
      partnerId: partner.id,
      conceivedAtTick: 0,
      dueAtTick: 9_000,
      gestationElapsedTicks: 10,
      parentDeathCause: "starvation",
      deathTick: 10,
      position: { ...parent.position },
    },
  });

  const detached = detachAgentOwnership(state, [], partner.id);
  assert.equal(detached.ok, true);
  assert.ok(detached.value);
  assert.equal(pregnancyLossEvents(detached.value.snapshot.state).length, 1, "no new loss event on handoff");
  assert.equal(pregnancyLossEvents(state).length, 1, "input state is not mutated");
  assert.ok(detached.value.agent, "detached agent keeps its own state");

  const movedLoss = detached.value.snapshot.state.events.find(
    (event) => event.kind === "pregnancy_lost",
  );
  assert.match(String(movedLoss.data?.partnerId), /^agent-global:/);

  const parentDetach = detachAgentOwnership(state, [], parent.id);
  assert.equal(parentDetach.ok, true);
  assert.ok(parentDetach.value?.agent.pregnancy, "pregnancy travels with the gestational parent");
});

test("pregnancy loss events are deterministic for the same state", () => {
  function run() {
    const { state, parent } = pregnantFixture({ seed: 9_907, dueAtTick: 50_000 });
    state.tick = naturalLifespanTicks(parent.id, 1);
    applyPopulationAging(state);
    return pregnancyLossEvents(state);
  }
  assert.deepEqual(run(), run());
});
