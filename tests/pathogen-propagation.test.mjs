import assert from "node:assert/strict";
import test from "node:test";
import { hexGridBoundaryCells } from "../dist-ts/src/hex-grid.js";
import {
  agentPathogenLoad,
  agentPathogenPressure,
  applyPathogenSteps,
  pathogenEdgeSnapshot,
  pathogenHaloPressureMap,
  pathogenRecoveryRate,
  pathogenStepCount,
} from "../dist-ts/src/pathogen.js";
import { shouldMaterializePathogenHalo } from "../dist-ts/src/pathogen-region.js";

function agent(id, position, pathogenLoad = undefined) {
  return {
    id,
    name: id,
    factionId: "faction-a",
    role: "forager",
    position: { ...position },
    hp: 100,
    energy: 100,
    capacity: 24,
    inventory: { wood: 0, stone: 0, food: 0 },
    autonomy: true,
    goal: "test",
    status: "idle",
    ...(pathogenLoad === undefined ? {} : { pathogenLoad }),
  };
}

test("six-neighbor contact transmits pathogen load without order-dependent long jumps", () => {
  const infected = agent("infected", { x: 0, y: 0 }, 1);
  const adjacent = agent("adjacent", { x: 1, y: 0 });
  const distant = agent("distant", { x: 3, y: 0 });
  const state = { agents: [infected, adjacent, distant] };

  assert.ok(applyPathogenSteps(state, 1) > 0);
  assert.ok(agentPathogenLoad(infected) < 1, "isolated load should recover between contacts");
  assert.ok(agentPathogenLoad(adjacent) > 0, "one-hex contact should transmit pressure");
  assert.equal(agentPathogenLoad(distant), 0, "infection must not jump beyond local hex contact in one step");
});

test("same-cell crowding is riskier than adjacency and halo seams preserve adjacent contact strength", () => {
  const sameCellTarget = agent("same-target", { x: 0, y: 0 });
  applyPathogenSteps({
    agents: [agent("same-source", { x: 0, y: 0 }, 1), sameCellTarget],
  }, 1);
  const sameCellLoad = agentPathogenLoad(sameCellTarget);

  const adjacentTarget = agent("adjacent-target", { x: 1, y: 0 });
  applyPathogenSteps({
    agents: [agent("adjacent-source", { x: 0, y: 0 }, 1), adjacentTarget],
  }, 1);
  const adjacentLoad = agentPathogenLoad(adjacentTarget);

  assert.ok(sameCellLoad > adjacentLoad, "co-located BOTs should have stronger direct contact exposure");
  assert.ok(adjacentLoad > 0, "ordinary six-neighbor contact must remain transmissible");

  const seamTarget = agent("seam-target", { x: 30, y: 11 });
  applyPathogenSteps(
    { agents: [seamTarget] },
    0,
    undefined,
    new Map([["30,11", 1]]),
    1,
  );
  assert.ok(
    Math.abs(agentPathogenLoad(seamTarget) - adjacentLoad) < 1e-12,
    "an exact cross-region neighbor must match local one-hex contact strength",
  );
});

test("subclinical pathogen load must build before an agent sheds infectious pressure", () => {
  const subclinical = agent("subclinical", { x: 0, y: 0 }, 0.1);
  const target = agent("target", { x: 1, y: 0 });
  assert.equal(agentPathogenPressure(subclinical), 0);

  applyPathogenSteps({ agents: [subclinical, target] }, 1);
  assert.equal(
    agentPathogenLoad(target),
    0,
    "latent ambient-scale burden should not immediately seed contact transmission",
  );

  const shedding = agent("shedding", { x: 0, y: 0 }, 0.56);
  assert.ok(
    Math.abs(agentPathogenPressure(shedding) - 0.5) < 1e-12,
    "infectious pressure should rise smoothly once burden exceeds the threshold",
  );
});

test("well-fed agents recover pathogen burden faster than exhausted agents", () => {
  const wellFed = agent("well-fed", { x: 0, y: 0 }, 1);
  const exhausted = agent("exhausted", { x: 0, y: 0 }, 1);
  wellFed.energy = 100;
  exhausted.energy = 0;

  assert.ok(pathogenRecoveryRate(wellFed) > pathogenRecoveryRate(exhausted));
  assert.ok(Math.abs(pathogenRecoveryRate({ energy: 50 }) - 0.06) < 1e-12);

  applyPathogenSteps({ agents: [wellFed] }, 1);
  applyPathogenSteps({ agents: [exhausted] }, 1);
  assert.ok(
    agentPathogenLoad(wellFed) < agentPathogenLoad(exhausted),
    "existing food/energy state should create a modest recovery advantage",
  );

  const susceptible = agent("susceptible", { x: 0, y: 0 });
  susceptible.energy = 0;
  applyPathogenSteps({ agents: [susceptible] }, 1);
  assert.equal(agentPathogenLoad(susceptible), 0, "low energy alone must never create infection");
});

test("pathogen halo maps exact neighbor edge pressure onto the paired local boundary cell", () => {
  const link = {
    sourceRegionId: "garden-1",
    sourcePosition: { x: 30, y: 11 },
    direction: "east",
    neighborRegionId: "garden-2",
    neighborPosition: { x: 8, y: 11 },
    neighborDirection: "west",
  };
  const pressure = pathogenHaloPressureMap([link], [{
    regionId: "garden-2",
    direction: "west",
    revision: 4,
    tick: 30,
    agents: [{ position: { ...link.neighborPosition }, pressure: 0.8 }],
  }]);
  assert.equal(pressure.get("30,11"), 0.8);

  const target = agent("target", link.sourcePosition);
  const state = { agents: [target] };
  applyPathogenSteps(state, 1, undefined, pressure, 1);
  assert.ok(agentPathogenLoad(target) > 0, "exact cross-region contact should transmit bounded load");
});

test("edge snapshots export only infectious boundary pressure and union co-located carriers", () => {
  const extent = { width: 40, height: 24 };
  const eastBoundary = hexGridBoundaryCells(extent, "east");
  const boundary = eastBoundary[0];
  const latentBoundary = eastBoundary[1];
  assert.ok(boundary);
  assert.ok(latentBoundary);
  const interior = { x: 19, y: 11 };
  const state = {
    regionId: "garden-1",
    revision: 9,
    tick: 30,
    ...extent,
    agents: [
      agent("a", boundary, 0.56),
      agent("b", boundary, 0.56),
      agent("latent", latentBoundary, 0.1),
      agent("interior", interior, 1),
    ],
  };
  const snapshot = pathogenEdgeSnapshot(state, "east");
  assert.equal(snapshot.agents.length, 1, "latent burden should not be exported across a region seam");
  assert.deepEqual(snapshot.agents[0].position, boundary);
  assert.ok(Math.abs(snapshot.agents[0].pressure - 0.75) < 1e-12);
});

test("pathogen cadence survives virtual catch-up and halo reads stay boundary-scoped", () => {
  assert.equal(pathogenStepCount(0, 60, 6), 10);
  assert.equal(pathogenStepCount(29, 30, 30), 1);
  assert.equal(pathogenStepCount(30, 59, 30), 0);

  const extent = { width: 40, height: 24 };
  const boundary = hexGridBoundaryCells(extent, "east")[0];
  assert.ok(boundary);
  const state = { ...extent, agents: [agent("center", { x: 19, y: 11 })] };
  assert.equal(shouldMaterializePathogenHalo(state, 29, 30), false, "interior BOTs should not wake neighbor DOs");
  state.agents[0].position = { ...boundary };
  assert.equal(shouldMaterializePathogenHalo(state, 28, 29), false, "non-halo cadence should not fetch edges");
  assert.equal(shouldMaterializePathogenHalo(state, 29, 30), true, "boundary BOT contact should use depth-1 halo");
});
