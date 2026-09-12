import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../public/client/hex-grid.js";
import { createObservationHistory, summarizeWorld } from "../public/client/world-observation.js";

function fixture() {
  return {
    worldId: "world-a", regionId: "garden-1", seed: 1234, tick: 10, rngState: 9876,
    width: 40, height: 24,
    tiles: [{ x: 19, y: 11, terrain: "plain" }, { x: 20, y: 11, terrain: "forest" }],
    agents: [],
  };
}

const agent = (id, energy, position = { x: 19, y: 11 }, pathogenLoad) => ({ id, energy, position, pathogenLoad });

test("observations exclude rectangular envelope and invalid hex positions", () => {
  const state = fixture();
  state.tiles = Array.from({ length: state.width * state.height }, (_, index) => ({
    x: index % state.width, y: Math.floor(index / state.width), terrain: "plain",
  }));
  state.tiles.push({ x: 19.5, y: 11, pathogenReservoir: 1 });
  state.agents = [
    agent("in", 75),
    agent("corner", 0, { x: 0, y: 0 }, 1),
    agent("outside", 0, { x: 40, y: 11 }, 1),
    agent("fractional", 0, { x: 19.5, y: 11 }, 1),
    { id: "missing-position", energy: 0 },
  ];
  const summary = summarizeWorld(state);
  assert.equal(summary.activeCells, state.tiles.filter(tile => isHexGridCell(tile, 40, 24)).length);
  assert.equal(summary.activeCells, 397);
  assert.equal(summary.population, 1);
  assert.equal(summary.meanEnergy, 75);
  assert.equal(summary.infectiousAgents, 0);
  assert.equal(summary.contaminatedCells, 0);
});

test("unknown energy and resource measurements are excluded rather than reported as zero", () => {
  const state = fixture();
  state.agents = [agent("a", undefined), agent("b", NaN), agent("c", "80"), agent("d", Infinity)];
  assert.equal(summarizeWorld(state).meanEnergy, null);
  assert.equal(summarizeWorld(state).resourceRatio, null);
  state.agents.push(agent("e", -20), agent("f", 120), agent("g", 50));
  assert.equal(summarizeWorld(state).meanEnergy, 50);
  const resources = [
    { kind: "wood", amount: 4, maxAmount: 10 },
    { kind: "stone", amount: 30, maxAmount: 20 },
    { kind: "food", amount: -5, maxAmount: 10 },
    { kind: "wood", maxAmount: 1000 },
    { kind: "wood", amount: 5, maxAmount: 0 },
    { kind: "food", amount: NaN, maxAmount: 1000 },
    { kind: "stone", amount: 5, maxAmount: Infinity },
    { kind: "wood", amount: "5", maxAmount: 1000 },
    { kind: "unknown", amount: 5, maxAmount: 1000 },
  ];
  state.tiles = resources.map((resource, index) => ({ x: 15 + index, y: 11, terrain: "plain", resource }));
  assert.equal(summarizeWorld(state).resourceRatio, 24 / 40);
  assert.equal(summarizeWorld({ ...state, agents: [], tiles: [] }).meanEnergy, null);
});

test("infectious and contaminated counts match simulation thresholds without counting tiny residuals", () => {
  const state = fixture();
  const values = [undefined, null, NaN, Infinity, "1", -1, 0, 0.0001, 0.12, 0.120001, 2];
  state.agents = values.map((value, index) => agent(`agent-${index}`, 50, { x: 19, y: 11 }, value));
  state.tiles = values.map((value, index) => ({ x: 14 + index, y: 11, terrain: "plain", pathogenReservoir: value }));
  const summary = summarizeWorld(state);
  assert.equal(summary.infectiousAgents, 2);
  assert.equal(summary.contaminatedCells, 3);
  assert.equal(summary.population, values.length);
});

test("crowding counts logical cells containing at least three BOTs", () => {
  const state = fixture();
  state.agents = [
    ...Array.from({ length: 4 }, (_, index) => agent(`a${index}`, 60)),
    ...Array.from({ length: 3 }, (_, index) => agent(`b${index}`, 60, { x: 20, y: 11 })),
    ...Array.from({ length: 2 }, (_, index) => agent(`c${index}`, 60, { x: 21, y: 11 })),
  ];
  assert.equal(summarizeWorld(state).crowdedCells, 2);
  assert.equal(summarizeWorld(state).maxCrowding, 4);
  assert.equal(summarizeWorld({ ...state, agents: [] }).maxCrowding, 0);
});

test("observation is read-only, preserves RNG, and tolerates missing snapshots", () => {
  const state = fixture();
  state.agents = [agent("one", 51)];
  const original = structuredClone(state);
  const history = createObservationHistory();
  summarizeWorld(state);
  history.sample(state);
  assert.deepEqual(state, original);
  assert.deepEqual(summarizeWorld(undefined), {
    activeCells: 0, population: 0, meanEnergy: null, infectiousAgents: 0,
    contaminatedCells: 0, resourceRatio: null, maxCrowding: 0, crowdedCells: 0,
  });
});

test("history is bounded and replaces the current tick rather than duplicating it", () => {
  const state = fixture();
  const history = createObservationHistory(3);
  for (let tick = 0; tick < 5; tick += 1) history.sample({ ...state, tick });
  const samples = history.sample({ ...state, tick: 4, agents: [agent("new", 70)] });
  assert.deepEqual(samples.map(sample => sample.tick), [2, 3, 4]);
  assert.deepEqual(samples[2], { tick: 4, population: 1, resourceRatio: null, meanEnergy: 70 });
  samples[0].population = 999;
  samples.push({ tick: 99 });
  assert.equal(history.sample({ ...state, tick: 4 })[0].population, 0);
});

test("history clears for rewind and for changes in world, region, or seed", () => {
  for (const changed of [{ tick: 4 }, { worldId: "world-b" }, { regionId: "garden-2" }, { seed: 99 }]) {
    const state = fixture();
    const history = createObservationHistory();
    history.sample(state);
    history.sample({ ...state, tick: 11 });
    const next = { ...state, tick: 12, ...changed };
    const samples = history.sample(next);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].tick, next.tick);
  }
});

test("history accepts a precomputed summary and ignores invalid tick samples", () => {
  const state = fixture();
  const history = createObservationHistory();
  const summary = { population: 9, resourceRatio: 0.4, meanEnergy: 70 };
  // An explicit summary must avoid scanning the same large state a second time.
  Object.defineProperty(state, "agents", { get() { throw new Error("redundant summary"); } });
  assert.deepEqual(history.sample(state, summary), [{ tick: 10, ...summary }]);
  for (const tick of [NaN, Infinity, -1, 1.5, "12"]) {
    assert.deepEqual(history.sample({ ...fixture(), tick }, summary), [{ tick: 10, ...summary }]);
  }
  for (const limit of [0, -1, NaN, Infinity, 1.5, "3"]) {
    assert.throws(() => createObservationHistory(limit), RangeError);
  }
});

test("default observation history retains at most sixty samples", () => {
  const state = fixture();
  const history = createObservationHistory();
  for (let tick = 0; tick < 100; tick += 1) history.sample({ ...state, tick });
  const samples = history.sample({ ...state, tick: 100 });
  assert.equal(samples.length, 60);
  assert.equal(samples[0].tick, 41);
  assert.equal(samples.at(-1).tick, 100);
});
