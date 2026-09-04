import assert from "node:assert/strict";
import test from "node:test";
import { createRandom } from "../dist-ts/src/prng.js";
import {
  applyHaloRegrowthCompensation,
  haloWaterDirectionsAt,
  resourceRegrowthChanceWithHalo,
  surfaceMoistureWithHaloAt,
} from "../dist-ts/src/halo-environment.js";
import { buildHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { resourceRegrowthChance, surfaceMoistureAt } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function fixture() {
  const state = createInitialWorld({ seed: 9301, width: 40, height: 24, regionId: "garden-1" });
  for (const tile of state.tiles) {
    if (tile.terrain !== "water") tile.terrain = "plain";
    delete tile.resource;
    tile.elevation = tile.terrain === "water" ? 0 : 0.8;
    tile.drainage = 0;
    delete tile.flowTo;
    tile.erosionPressure = 0;
  }
  for (const agent of state.agents) {
    agent.autonomy = false;
    delete agent.task;
  }

  const link = buildHexHaloLinks(state, ["garden-1", "garden-2"], "garden-1")
    .filter((entry) => entry.direction === "east")[11];
  assert.ok(link);
  const tile = state.tiles[link.sourcePosition.y * state.width + link.sourcePosition.x];
  assert.ok(tile);
  tile.terrain = "forest";
  tile.elevation = 0.8;
  tile.resource = { kind: "wood", amount: 0, maxAmount: 10 };
  const halo = [{
    ...link,
    tile: {
      x: link.neighborPosition.x,
      y: link.neighborPosition.y,
      terrain: "water",
      elevation: 0,
    },
  }];
  return { state, tile, halo, link };
}

test("immediate ghost water raises boundary surface moisture exactly as distance-one water", () => {
  const { state, tile, halo } = fixture();
  const local = surfaceMoistureAt(state, tile);
  const haloAware = surfaceMoistureWithHaloAt(state, tile, halo);
  assert.ok(haloAware > local + 0.5, `${haloAware} should materially exceed ${local}`);
  assert.deepEqual(haloWaterDirectionsAt(tile, halo), ["east"]);
  assert.ok(resourceRegrowthChanceWithHalo(state, tile, halo) > resourceRegrowthChance(state, tile));
});

test("halo moisture does not affect an interior cell with no directional ghost link", () => {
  const { state, halo } = fixture();
  const interior = state.tiles[11 * state.width + 19];
  assert.ok(interior);
  interior.terrain = "forest";
  interior.resource = { kind: "wood", amount: 0, maxAmount: 10 };
  assert.equal(
    surfaceMoistureWithHaloAt(state, interior, halo),
    surfaceMoistureAt(state, interior),
  );
});

test("conditional compensation raises the base regrowth probability without double growth", () => {
  const { state, tile, halo } = fixture();
  state.tick = 29;
  const before = structuredClone(state);
  const after = structuredClone(state);
  after.tick = 30;

  const localChance = resourceRegrowthChance(after, tile);
  const haloChance = resourceRegrowthChanceWithHalo(after, tile, halo);
  const conditional = (haloChance - localChance) / (1 - localChance);
  assert.ok(conditional > 0);

  let selectedState;
  for (let seed = 1; seed < 100000; seed += 1) {
    const random = createRandom(seed);
    if (random.next() < conditional) {
      selectedState = seed;
      break;
    }
  }
  assert.ok(selectedState);
  after.rngState = selectedState;
  const grown = applyHaloRegrowthCompensation(before, after, halo, 30);
  assert.equal(grown, 1);
  const grownTile = after.tiles[tile.y * after.width + tile.x];
  assert.equal(grownTile.resource.amount, 1);

  const alreadyGrown = structuredClone(after);
  alreadyGrown.tick = 30;
  const previous = structuredClone(before);
  alreadyGrown.tiles[tile.y * alreadyGrown.width + tile.x].resource.amount = 1;
  const second = applyHaloRegrowthCompensation(previous, alreadyGrown, halo, 30);
  assert.equal(second, 0);
  assert.equal(alreadyGrown.tiles[tile.y * alreadyGrown.width + tile.x].resource.amount, 1);
});
