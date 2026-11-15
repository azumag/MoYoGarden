import assert from "node:assert/strict";
import test from "node:test";
import {
  POPULATION_BASAL_FOOD_INTERVAL_TICKS,
  POPULATION_ELDER_AGE_TICKS,
  applyPopulationAging,
  applyPopulationMaintenance,
  inheritHeritableTraits,
  naturalLifespanTicks,
} from "../dist-ts/src/demography.js";
import {
  detachAgentOwnership,
  globalHandoffAgentId,
} from "../dist-ts/src/agent-ownership.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function pregnantAdult(state, id = "pregnant-parent") {
  const base = structuredClone(state.agents[0]);
  assert.ok(base);
  base.id = id;
  base.name = "Pregnant Parent";
  base.factionId = state.factions[0].id;
  base.hp = 100;
  base.energy = 100;
  base.autonomy = false;
  base.birthTick = 0;
  base.lifeStage = "adult";
  base.reproductiveRole = "gestational";
  base.heritableTraits = { vitality: 1, carryingCapacity: 1 };
  base.pregnancy = {
    partnerId: "partner-agent",
    conceivedAtTick: 0,
    dueAtTick: 8_640,
    partnerTraits: { vitality: 1, carryingCapacity: 1 },
  };
  delete base.task;
  return base;
}

function stripFood(state) {
  for (const faction of state.factions) faction.resources.food = 0;
  for (const structure of state.structures) structure.storage.food = 0;
  for (const tile of state.tiles) {
    if (tile.resource?.kind === "food") tile.resource.amount = 0;
  }
}

function eventsOf(state, kind, agentId) {
  return state.events.filter(
    (event) => event.kind === kind && (agentId === undefined || event.agentId === agentId),
  );
}

function assertSingleLoss(state, agent, cause) {
  const deaths = eventsOf(state, "agent_died", agent.id);
  assert.equal(deaths.length, 1, "expected exactly one agent_died event");
  assert.equal(deaths[0].data?.cause, cause);

  const losses = eventsOf(state, "pregnancy_lost", agent.id);
  assert.equal(losses.length, 1, "expected exactly one pregnancy_lost event");
  assert.equal(losses[0].data?.outcome, "gestational_parent_died");
  assert.equal(losses[0].data?.parentId, agent.id);
  assert.equal(losses[0].data?.parentDeathCause, cause);
  return losses[0];
}

test("gestational parent death by natural lifespan emits agent_died then one pregnancy_lost", () => {
  const state = createInitialWorld({ seed: 39100 });
  const agent = pregnantAdult(state, "lifespan-parent");
  agent.position = { x: 3, y: 4 };
  state.agents = [agent];
  state.tick = naturalLifespanTicks(agent.id, 1);

  applyPopulationAging(state);

  assert.equal(state.agents.length, 0);
  const loss = assertSingleLoss(state, agent, "natural_lifespan");
  const death = eventsOf(state, "agent_died", agent.id)[0];
  assert.ok(
    state.events.indexOf(death) < state.events.indexOf(loss),
    "agent_died must precede pregnancy_lost for the same death",
  );
  assert.equal(loss.data?.conceivedAtTick, 0);
  assert.equal(loss.data?.dueAtTick, 8_640);
  assert.equal(loss.data?.gestationElapsedTicks, state.tick);
  assert.equal(loss.data?.deathTick, state.tick);
  assert.deepEqual(loss.data?.position, { x: 3, y: 4 });
});

test("gestational parent death by basal food deficit emits one pregnancy_lost", () => {
  const state = createInitialWorld({ seed: 39101 });
  const faction = state.factions[0];
  assert.ok(faction);
  stripFood(state);

  const agent = pregnantAdult(state, "basal-parent");
  agent.factionId = faction.id;
  agent.position = { x: 5, y: 6 };
  agent.hp = 1;
  agent.energy = 10;
  state.agents = [agent];
  state.tick = POPULATION_BASAL_FOOD_INTERVAL_TICKS;

  applyPopulationMaintenance(state);

  assert.equal(state.agents.length, 0);
  const loss = assertSingleLoss(state, agent, "basal_food_deficit");
  assert.equal(loss.data?.gestationElapsedTicks, state.tick);
  assert.deepEqual(loss.data?.position, { x: 5, y: 6 });
});

test("runtime starvation of a gestational parent emits one pregnancy_lost without counting as a second death", () => {
  const state = createInitialWorld({ seed: 39102 });
  stripFood(state);

  const agent = pregnantAdult(state, "starve-parent");
  agent.hp = 1;
  agent.energy = 0;
  agent.autonomy = true;
  state.agents = [agent];

  const runtime = new WorldRuntime({ state });
  const result = runtime.tick();
  const snapshot = runtime.snapshot();

  assert.equal(snapshot.agents.length, 0);
  assert.equal(result.deaths, 1, "pregnancy_lost must not inflate the deaths count");
  assert.equal(result.births, 0);
  const loss = assertSingleLoss(snapshot, agent, "starvation");
  assert.equal(loss.data?.partnerId, "partner-agent");
  assert.equal(loss.data?.gestationElapsedTicks, snapshot.tick);
});

test("death on the due tick prevents birth and records only pregnancy_lost", () => {
  const state = createInitialWorld({ seed: 39103 });
  const agent = pregnantAdult(state, "due-death-parent");
  const deathTick = naturalLifespanTicks(agent.id, 1);
  agent.pregnancy = {
    partnerId: "partner-agent",
    conceivedAtTick: deathTick - 4_320,
    dueAtTick: deathTick,
    partnerTraits: { vitality: 1, carryingCapacity: 1 },
  };
  state.agents = [agent];
  state.tick = deathTick - 1;

  const runtime = new WorldRuntime({ state });
  runtime.tick();
  const snapshot = runtime.snapshot();

  assert.equal(snapshot.tick, deathTick);
  assert.equal(snapshot.agents.length, 0, "no newborn may be created from an interrupted gestation");
  const loss = assertSingleLoss(snapshot, agent, "natural_lifespan");
  assert.equal(loss.data?.dueAtTick, deathTick);
  assert.equal(loss.data?.deathTick, deathTick);
  assert.equal(loss.data?.gestationElapsedTicks, 4_320);
});

test("partner death does not interrupt gestation; birth still inherits snapshot traits", () => {
  const state = createInitialWorld({ seed: 39104 });
  const faction = state.factions[0];
  assert.ok(faction);

  const parent = pregnantAdult(state, "surviving-parent");
  const partner = structuredClone(state.agents[0]);
  assert.ok(partner);
  partner.id = "partner-agent";
  partner.name = "Partner";
  partner.factionId = faction.id;
  partner.hp = 1;
  partner.energy = 10;
  partner.autonomy = false;
  partner.birthTick = 0;
  partner.lifeStage = "adult";
  partner.reproductiveRole = "partner";
  partner.heritableTraits = { vitality: 1, carryingCapacity: 1 };
  delete partner.task;
  parent.pregnancy = {
    partnerId: partner.id,
    conceivedAtTick: 360,
    dueAtTick: 9_000,
    partnerTraits: { vitality: 1, carryingCapacity: 1 },
  };
  state.agents = [parent, partner];
  stripFood(state);
  state.tick = POPULATION_BASAL_FOOD_INTERVAL_TICKS;

  applyPopulationMaintenance(state);

  assert.equal(state.agents.length, 1, "only the partner dies");
  assert.equal(state.agents[0]?.id, parent.id);
  assert.equal(eventsOf(state, "pregnancy_lost").length, 0);
  assert.equal(eventsOf(state, "agent_died", partner.id).length, 1);
  assert.ok(state.agents[0]?.pregnancy, "pregnancy must survive the partner death");

  const expectedChildId = `agent-${faction.id}-birth-9000-2`;
  const expectedTraits = inheritHeritableTraits(
    parent,
    parent.pregnancy.partnerTraits,
    expectedChildId,
  );

  state.tick = 8_999;
  const runtime = new WorldRuntime({ state });
  runtime.tick();
  const snapshot = runtime.snapshot();

  assert.equal(snapshot.tick, 9_000);
  assert.equal(eventsOf(snapshot, "pregnancy_lost").length, 0);
  const newborn = snapshot.agents.find((agent) => agent.id === expectedChildId);
  assert.ok(newborn, "expected the due pregnancy to still birth");
  assert.equal(newborn.lifeStage, "infant");
  assert.deepEqual(newborn.parents, [parent.id, partner.id]);
  assert.deepEqual(newborn.heritableTraits, expectedTraits);
  const survivingParent = snapshot.agents.find((agent) => agent.id === parent.id);
  assert.equal(survivingParent?.pregnancy, undefined);
  assert.equal(survivingParent?.lastBirthTick, 9_000);
});

test("elder transition keeps gestation; only the elder's own death interrupts it", () => {
  const state = createInitialWorld({ seed: 39105 });
  const agent = pregnantAdult(state, "elder-parent");
  state.agents = [agent];

  state.tick = POPULATION_ELDER_AGE_TICKS;
  applyPopulationAging(state);

  const elder = state.agents.find((entry) => entry.id === agent.id);
  assert.ok(elder);
  assert.equal(elder.lifeStage, "elder");
  assert.ok(elder.pregnancy, "elder transition must not cancel an existing pregnancy");
  assert.equal(eventsOf(state, "pregnancy_lost").length, 0);

  state.tick = naturalLifespanTicks(agent.id, 1);
  applyPopulationAging(state);

  assert.equal(state.agents.length, 0);
  const loss = assertSingleLoss(state, agent, "natural_lifespan");
  const death = eventsOf(state, "agent_died", agent.id)[0];
  assert.equal(death.data?.lifeStage, "elder");
});

test("region handoff preserves pregnancy without emitting pregnancy_lost, and promotes stored data.partnerId", () => {
  const source = createInitialWorld({ seed: 39106, width: 40, height: 24, regionId: "garden-1" });
  const mover = source.agents[0];
  const partner = source.agents[1];
  assert.ok(mover);
  assert.ok(partner);

  mover.pregnancy = {
    partnerId: partner.id,
    conceivedAtTick: 1,
    dueAtTick: 10,
  };
  // A historical loss event recorded while the mover was still region-local.
  // Its data.partnerId must track the mover's promoted identity after handoff.
  source.events.push({
    id: "event-historical-loss",
    tick: 2,
    kind: "pregnancy_lost",
    message: "historical gestational parent died while pregnant",
    agentId: "agent-dead-parent",
    factionId: mover.factionId,
    data: {
      outcome: "gestational_parent_died",
      parentId: "agent-dead-parent",
      partnerId: mover.id,
      conceivedAtTick: 0,
      dueAtTick: 1,
      gestationElapsedTicks: 1,
      parentDeathCause: "starvation",
      deathTick: 2,
    },
  });

  const detached = detachAgentOwnership(source, [], mover.id);
  assert.equal(detached.ok, true);
  assert.ok(detached.value);

  const promotedMoverId = globalHandoffAgentId(mover.id, source.regionId);
  const promotedPartnerId = globalHandoffAgentId(partner.id, source.regionId);

  // Detach is not a death: the moving agent keeps its pregnancy and no new
  // pregnancy_lost event is appended.
  assert.ok(detached.value.agent.pregnancy);
  assert.equal(detached.value.agent.pregnancy.partnerId, promotedPartnerId);
  const losses = eventsOf(detached.value.snapshot.state, "pregnancy_lost");
  assert.equal(losses.length, 1, "only the pre-existing historical loss remains");
  assert.equal(losses[0].id, "event-historical-loss");
  assert.equal(losses[0].data?.partnerId, promotedMoverId);
});

test("pregnancy loss events are deterministic for the same seed and operations", () => {
  function run() {
    const state = createInitialWorld({ seed: 39107 });
    stripFood(state);
    const agent = pregnantAdult(state, "determinism-parent");
    agent.hp = 1;
    agent.energy = 0;
    agent.autonomy = true;
    state.agents = [agent];
    const runtime = new WorldRuntime({ state });
    runtime.tick();
    return runtime.snapshot().events;
  }
  assert.deepEqual(run(), run());
});
