import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SIMULATION_CONFIG, emptyInventory } from "../dist-ts/src/protocol.js";
import {
  applyTerrainErosion,
  simulate,
  terrainErosionPressureAt,
  updateTileHydrology,
} from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds } from "../dist-ts/src/world.js";

function channelFixture() {
  const state = createInitialWorld({ seed: 3033, width: 16, height: 12 });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    tile.elevation = 0.95;
    delete tile.resource;
    delete tile.flowTo;
    delete tile.drainage;
    delete tile.erosionPressure;
  }
  for (let x = 3; x <= 9; x += 1) getTile(state, { x, y: 6 }).elevation = 0.8 - (x - 3) * 0.1;
  // A closed land-only basin keeps all displaced sediment in the measured set.
  getTile(state, { x: 10, y: 6 }).elevation = 0.1;
  const source = getTile(state, { x: 7, y: 6 });
  source.resource = { kind: "wood", amount: 2, maxAmount: 2 };
  const agent = state.agents[0];
  agent.position = { x: source.x, y: source.y };
  agent.autonomy = false;
  agent.inventory = emptyInventory();
  delete agent.task;
  state.agents = [agent];
  return state;
}

const sourceAt = (state) => getTile(state, { x: 7, y: 6 });
const landSum = (state) => state.tiles
  .filter((tile) => tile.terrain !== "water")
  .reduce((sum, tile) => sum + tile.elevation, 0);
const harvestCommand = (state) => ({
  id: `harvest-${state.tick}`, agentId: state.agents[0].id, submittedAtTick: state.tick,
  type: "gather", resource: "wood", target: { x: 7, y: 6 },
});

test("erosion reads present vegetation rather than cached pre-harvest pressure", () => {
  const standing = channelFixture();
  updateTileHydrology(standing);
  const harvested = structuredClone(standing);
  const cutSource = sourceAt(harvested);
  const cachedPressure = cutSource.erosionPressure;
  cutSource.resource.amount = 0;
  assert.ok(terrainErosionPressureAt(harvested, cutSource) > cachedPressure);
  const landBefore = landSum(harvested);
  applyTerrainErosion(standing);
  applyTerrainErosion(harvested);
  assert.ok(sourceAt(harvested).elevation < sourceAt(standing).elevation);
  assert.ok(Math.abs(landSum(harvested) - landBefore) < 1e-10, "land-to-land sediment is conserved");
  assert.ok(harvested.tiles.every((tile) => tile.elevation >= 0.01 && tile.elevation <= 0.99));
});

test("harvesting during tick 120 immediately changes erosion without shifting its cadence", () => {
  const initial = channelFixture();
  initial.tick = 119;
  // Disable regrowth on the compared ticks so vegetation differs only by BOT work.
  const config = { ...DEFAULT_SIMULATION_CONFIG, resourceRegrowthInterval: 121 };
  const harvested = simulate(initial, [harvestCommand(initial)], config).state;
  const standing = simulate(initial, [], config).state;
  assert.equal(harvested.tick, 120);
  assert.equal(sourceAt(harvested).resource.amount, 0);
  assert.equal(sourceAt(standing).resource.amount, 2);
  assert.ok(sourceAt(harvested).elevation < sourceAt(standing).elevation);
  assert.equal(harvested.rngState, standing.rngState);

  const beforeBoundary = channelFixture();
  beforeBoundary.tick = 118;
  const next = simulate(beforeBoundary, [harvestCommand(beforeBoundary)], config).state;
  assert.equal(next.tick, 119);
  assert.equal(sourceAt(next).elevation, sourceAt(beforeBoundary).elevation);
  // The existing rectangular envelope may contain non-owned cells; validate
  // bounds on owned land cells after the normal hex migration path.
  assert.ok(harvested.tiles.filter((tile) => inBounds(harvested, tile) && tile.terrain !== "water")
    .every((tile) => Number.isFinite(tile.elevation) && tile.elevation >= 0.01 && tile.elevation <= 0.99));
});

test("unchanged vegetation retains the cached-pressure transfer and drainage input", () => {
  const state = channelFixture();
  updateTileHydrology(state);
  // Isolate a single land-to-land transfer. Preserve the supplied drainage
  // contribution; refreshing vegetation must not discard hydrological inputs.
  for (const tile of state.tiles) delete tile.flowTo;
  const source = sourceAt(state);
  const target = getTile(state, { x: 8, y: 6 });
  source.flowTo = { x: target.x, y: target.y };
  source.drainage = 0.75;
  source.erosionPressure = terrainErosionPressureAt(state, source);
  const expected = Math.min(0.001 * source.erosionPressure, (source.elevation - target.elevation) * 0.2, source.elevation - 0.01);
  const beforeSource = source.elevation;
  const beforeTarget = target.elevation;
  const moved = applyTerrainErosion(state);
  assert.equal(moved, expected);
  assert.equal(source.elevation, beforeSource - expected);
  assert.equal(target.elevation, beforeTarget + expected);
});
