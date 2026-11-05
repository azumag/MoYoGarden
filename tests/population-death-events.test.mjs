import assert from "node:assert/strict";
import test from "node:test";
import {
  POPULATION_BASAL_FOOD_INTERVAL_TICKS,
  applyConstructionCollaborationFamiliarity,
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


test("agent_died events do not affect construction relationship extraction (R1/②)", () => {
  const state = createInitialWorld({ seed: 39043 });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  for (const tile of state.tiles) if (tile.terrain === "water") tile.terrain = "plain";
  const [a, b] = state.agents.filter((agent) => agent.factionId === faction.id).slice(0, 2);
  assert.ok(a && b);
  delete a.socialMemory; delete b.socialMemory;
  state.structures = [{ id: "shared-workshop-r1", factionId: faction.id, type: "workshop", position: { ...a.position }, status: "active", progress: 13, requiredProgress: 13, storage: { wood: 0, stone: 0, food: 0 } }];
  const workEvents = [
    { id: "w1", tick: 100, kind: "construction_started", message: "s", agentId: a.id, factionId: faction.id, position: { ...a.position }, data: { structureId: "shared-workshop-r1" } },
    { id: "w2", tick: 101, kind: "construction_progress", message: "p", agentId: b.id, factionId: faction.id, position: { ...b.position }, data: { structureId: "shared-workshop-r1" } },
  ];
  const deaths = Array.from({ length: 400 }, (_, i) => ({ id: `d${i}`, tick: 50 + i, kind: "agent_died", message: "d", agentId: `dead-${i}`, factionId: faction.id, position: { x: 0, y: 0 }, data: { cause: "starvation", deathTick: 50 + i, position: { x: 0, y: 0 } } }));
  state.events = [...deaths, ...workEvents]; state.tick = 200;
  applyConstructionCollaborationFamiliarity(state);
  assert.equal(a.socialMemory?.[0]?.agentId, b.id);
  assert.equal(a.socialMemory?.[0]?.familiarity, 1);
  assert.equal(b.socialMemory?.[0]?.agentId, a.id);
});

test("same socialMemory gives same pairing decision despite mass death events (R1/②)", () => {
  function run(withDeaths) {
    const state = createInitialWorld({ seed: 39044 });
    const faction = state.factions.find((entry) => entry.id === "ember");
    assert.ok(faction);
    const templates = state.agents.filter((agent) => agent.factionId === faction.id);
    for (const tile of state.tiles) if (tile.terrain === "water") tile.terrain = "plain";
    const pos = { x: Math.max(1, Math.min(state.width - 2, templates[0].position.x)), y: Math.max(1, Math.min(state.height - 2, templates[0].position.y)) };
    state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
    const mk = (id, role, xOff) => { const agent = structuredClone(templates[0]); agent.id = id; agent.name = id; agent.factionId = faction.id; agent.position = { x: pos.x + xOff, y: pos.y }; agent.hp = 100; agent.energy = 100; agent.autonomy = false; agent.lifeStage = "adult"; agent.reproductiveRole = role; delete agent.birthTick; delete agent.pregnancy; delete agent.lastBirthTick; delete agent.parents; delete agent.task; return agent; };
    const parent = mk("r1-parent", "gestational", 0);
    const partner = mk("r1-partner", "partner", 1);
    parent.socialMemory = [{ agentId: partner.id, familiarity: 5, lastInteractionTick: 1 }];
    partner.socialMemory = [{ agentId: parent.id, familiarity: 5, lastInteractionTick: 1 }];
    state.agents.push(parent, partner);
    state.structures = state.structures.filter((s) => s.factionId !== faction.id);
    state.structures.push({ id: "r1-camp", factionId: faction.id, type: "camp", position: { ...pos }, status: "active", progress: 6, requiredProgress: 6, storage: { wood: 0, stone: 0, food: 100 } });
    faction.resources.food = 100;
    state.events = withDeaths ? Array.from({ length: 400 }, (_, i) => ({ id: `md${i}`, tick: 8000 + i, kind: "agent_died", message: "d", agentId: `dead-${i}`, factionId: faction.id, position: { x: 0, y: 0 }, data: { cause: "natural_lifespan", deathTick: 8000 + i, position: { x: 0, y: 0 } } })) : [];
    state.tick = 8639;
    return new WorldRuntime({ state }).tick().state.agents.find((a) => a.id === parent.id)?.pregnancy?.partnerId;
  }
  assert.equal(run(false), "r1-partner");
  assert.equal(run(true), "r1-partner");
});

test("death events and tick stats are deterministic for same seed (R2/①)", () => {
  function run() {
    const state = createInitialWorld({ seed: 39045 });
    const faction = state.factions[0]; assert.ok(faction);
    faction.resources.food = 0;
    for (const s of state.structures) s.storage.food = 0;
    for (const t of state.tiles) if (t.resource?.kind === "food") t.resource.amount = 0;
    for (const a of state.agents) { a.energy = 0; a.hp = 2; a.autonomy = true; delete a.task; }
    const runtime = new WorldRuntime({ state });
    const totals = { births: 0, deaths: 0 };
    for (let i = 0; i < 5; i += 1) { const r = runtime.tick(); totals.births += r.births; totals.deaths += r.deaths; }
    const snap = runtime.snapshot();
    const deaths = snap.events.filter((e) => e.kind === "agent_died").map((e) => [e.tick, e.agentId, e.data?.cause, e.position?.x, e.position?.y]);
    return { totals, deaths, tick: snap.tick };
  }
  assert.deepEqual(run(), run());
});
