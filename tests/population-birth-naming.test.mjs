import assert from "node:assert/strict";
import test from "node:test";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function emberWorld(seed) {
  const state = createInitialWorld({ seed });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const parents = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(parents.length >= 3);
  state.tick = 7;
  return { state, faction, parents };
}

function expectBirth(state, parentId, dueAtTick = 8) {
  const parent = state.agents.find((agent) => agent.id === parentId);
  assert.ok(parent);
  parent.hp = 100;
  parent.energy = 100;
  parent.reproductiveRole = "gestational";
  parent.pregnancy = {
    partnerId: "naming-partner",
    conceivedAtTick: Math.max(0, dueAtTick - 1),
    dueAtTick,
  };
}

function tickForBirths(state) {
  const next = new WorldRuntime({ state }).tick().state;
  return {
    state: next,
    born: next.agents.filter((agent) => agent.birthTick === next.tick),
  };
}

test("a new world keeps the legacy first-birth name while persisting the counter", () => {
  const { state, faction, parents } = emberWorld(9101);
  assert.equal(faction.birthSequence, 4);
  assert.equal(state.schemaVersion, 1);

  expectBirth(state, parents[0].id);
  const { state: next, born } = tickForBirths(state);

  assert.equal(born.length, 1);
  assert.equal(born[0].name, "Ember 5");
  assert.equal(next.factions.find((entry) => entry.id === faction.id).birthSequence, 5);
  assert.equal(next.schemaVersion, 1);
});

test("a birth after a death does not reuse the display name and leaves existing names alone", () => {
  const { state, faction, parents } = emberWorld(9102);
  expectBirth(state, parents[0].id);
  const first = tickForBirths(state);
  assert.equal(first.born[0].name, "Ember 5");

  // Remove the child to model a death between births; the issued number must
  // stay spent even though the live population returns to its previous size.
  first.state.agents = first.state.agents.filter((agent) => agent.id !== first.born[0].id);
  const namesBefore = new Map(first.state.agents.map((agent) => [agent.id, agent.name]));

  first.state.tick = 9;
  expectBirth(first.state, parents[1].id, 10);
  const second = tickForBirths(first.state);

  assert.equal(second.born.length, 1);
  assert.equal(second.born[0].name, "Ember 6");
  assert.equal(second.state.factions.find((entry) => entry.id === faction.id).birthSequence, 6);
  for (const agent of second.state.agents) {
    if (!namesBefore.has(agent.id)) continue;
    assert.equal(agent.name, namesBefore.get(agent.id));
  }
});

test("multiple births in one tick receive distinct numbers", () => {
  const { state, parents } = emberWorld(9103);
  expectBirth(state, parents[0].id, 8);
  expectBirth(state, parents[1].id, 8);

  const { born } = tickForBirths(state);

  assert.equal(born.length, 2);
  assert.deepEqual(born.map((agent) => agent.name).sort(), ["Ember 5", "Ember 6"]);
});

test("a legacy save without the counter seeds it from existing names and population", () => {
  const { state, faction, parents } = emberWorld(9104);
  delete faction.birthSequence;

  const legacyChild = structuredClone(parents[2]);
  legacyChild.id = "agent-ember-birth-legacy";
  legacyChild.name = "Ember 12";
  legacyChild.birthTick = 1;
  legacyChild.lifeStage = "juvenile";
  legacyChild.autonomy = false;
  delete legacyChild.pregnancy;
  delete legacyChild.task;
  state.agents.push(legacyChild);

  expectBirth(state, parents[0].id);
  const { state: next, born } = tickForBirths(state);

  assert.equal(born.length, 1);
  assert.equal(born[0].name, "Ember 13");
  assert.equal(next.factions.find((entry) => entry.id === faction.id).birthSequence, 13);
  assert.equal(next.agents.find((agent) => agent.id === legacyChild.id).name, "Ember 12");
});

test("naming is deterministic for the same state", () => {
  const { state, parents } = emberWorld(9105);
  expectBirth(state, parents[0].id);

  const first = tickForBirths(structuredClone(state));
  const second = tickForBirths(structuredClone(state));
  const firstName = first.born.map((agent) => agent.name);
  const secondName = second.born.map((agent) => agent.name);

  assert.deepEqual(firstName, secondName);
  assert.deepEqual(
    first.state.factions.map((entry) => entry.birthSequence),
    second.state.factions.map((entry) => entry.birthSequence),
  );
});

test("faction counters are independent", () => {
  const { state } = emberWorld(9106);
  for (const factionId of ["ember", "verdant"]) {
    const parent = state.agents.find((agent) => agent.factionId === factionId);
    assert.ok(parent);
    expectBirth(state, parent.id);
  }

  const { born } = tickForBirths(state);

  assert.deepEqual(born.map((agent) => agent.name).sort(), ["Ember 5", "Verdant 5"]);
});

test("a resident carrying a higher number from another region raises the next local number", () => {
  const { state, parents } = emberWorld(9107);
  const migrant = structuredClone(parents[2]);
  migrant.id = "agent-global:migrant-region:legacy-resident";
  migrant.name = "Ember 40";
  migrant.birthTick = 1;
  migrant.lifeStage = "adult";
  migrant.autonomy = false;
  delete migrant.pregnancy;
  delete migrant.task;
  state.agents.push(migrant);

  expectBirth(state, parents[0].id);
  const { state: next, born } = tickForBirths(state);

  assert.equal(born.length, 1);
  assert.equal(born[0].name, "Ember 41");
  assert.equal(next.factions.find((entry) => entry.id === "ember").birthSequence, 41);
});
