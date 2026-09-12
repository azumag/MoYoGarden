import assert from "node:assert/strict";
import test from "node:test";
import {
  agentPathogenLoad,
  applyPathogenSteps,
  tilePathogenReservoir,
} from "../dist-ts/src/pathogen.js";

function agent(id, position, pathogenLoad = undefined, pathogenImmunity = undefined) {
  return {
    id,
    name: id,
    factionId: "faction-a",
    role: "forager",
    position: { ...position },
    hp: 100,
    energy: 50,
    capacity: 24,
    inventory: { wood: 0, stone: 0, food: 0 },
    autonomy: true,
    goal: "test",
    status: "idle",
    ...(pathogenLoad === undefined ? {} : { pathogenLoad }),
    ...(pathogenImmunity === undefined ? {} : { pathogenImmunity }),
  };
}

function tile(position, pathogenReservoir = undefined) {
  return {
    ...position,
    terrain: "plain",
    ...(pathogenReservoir === undefined ? {} : { pathogenReservoir }),
  };
}

test("infectious carriers leave a decaying environmental reservoir that can expose a later BOT", () => {
  const position = { x: 4, y: 4 };
  const cell = tile(position);
  const state = {
    agents: [agent("carrier", position, 1)],
    tiles: [cell],
  };

  applyPathogenSteps(state, 1);
  const shed = tilePathogenReservoir(cell);
  assert.ok(shed > 0, "an infectious carrier should contaminate its current hex");

  state.agents = [];
  applyPathogenSteps(state, 1);
  const decayed = tilePathogenReservoir(cell);
  assert.ok(decayed > 0 && decayed < shed, "reservoir burden should persist but decay without a carrier");

  const susceptible = agent("later-occupant", position);
  state.agents = [susceptible];
  applyPathogenSteps(state, 1);
  assert.ok(
    agentPathogenLoad(susceptible) > 0,
    "a later occupant should receive exposure from the pre-existing reservoir",
  );
});

test("climate cannot create a reservoir without a carrier and acquired immunity reduces reservoir exposure", () => {
  const environment = { worldSeed: 20260912, originX: 0, originY: 0 };
  const fresh = tile({ x: 8, y: 8 });
  applyPathogenSteps({ agents: [], tiles: [fresh] }, 32, environment);
  assert.equal(
    tilePathogenReservoir(fresh),
    0,
    "climate alone must not manufacture environmental pathogen burden",
  );

  const naive = agent("naive", { x: 2, y: 2 });
  const immune = agent("immune", { x: 2, y: 2 }, undefined, 0.9);
  const naiveTile = tile({ x: 2, y: 2 }, 0.8);
  const immuneTile = tile({ x: 2, y: 2 }, 0.8);

  applyPathogenSteps({ agents: [naive], tiles: [naiveTile] }, 1);
  applyPathogenSteps({ agents: [immune], tiles: [immuneTile] }, 1);

  assert.ok(agentPathogenLoad(naive) > 0, "reservoir exposure should affect a susceptible BOT");
  assert.ok(
    agentPathogenLoad(immune) < agentPathogenLoad(naive),
    "the existing acquired-immunity rule should also reduce reservoir exposure",
  );
});
