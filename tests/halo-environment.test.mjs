import assert from "node:assert/strict";
import test from "node:test";
import { createRandom } from "../dist-ts/src/prng.js";
import {
  applyHaloRegrowthCompensation,
  haloDrainageInflowAt,
  haloWaterDirectionsAt,
  resourceRegrowthChanceWithHalo,
  surfaceMoistureWithHaloAt,
} from "../dist-ts/src/halo-environment.js";
import { buildHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { resourceRegrowthChance, surfaceMoistureAt } from "../dist-ts/src/simulation.js";
import { sampleWorldWind } from "../dist-ts/src/world-scale.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function fixture() {
  const state = createInitialWorld({ seed: 9301, width: 40, height: 24, regionId: "garden-1" });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    delete tile.resource;
    tile.elevation = 0.8;
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

function environmentFrameForWind(tile, direction) {
  const worldSeed = 424242;
  for (let originY = -768; originY <= 768; originY += 16) {
    for (let originX = -768; originX <= 768; originX += 16) {
      const wind = sampleWorldWind(worldSeed, originX + tile.x, originY + tile.y);
      if (wind.direction === direction && wind.strength >= 0.2) {
        return { worldSeed, originX, originY };
      }
    }
  }
  assert.fail(`could not find deterministic ${direction} wind fixture`);
}

test("immediate ghost water raises boundary surface moisture exactly as distance-one water", () => {
  const { state, tile, halo } = fixture();
  const local = surfaceMoistureAt(state, tile);
  const haloAware = surfaceMoistureWithHaloAt(state, tile, halo);
  assert.ok(haloAware > local + 0.5, `${haloAware} should materially exceed ${local}`);
  assert.deepEqual(haloWaterDirectionsAt(tile, halo), ["east"]);
  assert.ok(resourceRegrowthChanceWithHalo(state, tile, halo) > resourceRegrowthChance(state, tile));
});

test("unresolved upstream ghost catchment contributes runoff across the boundary", () => {
  const { state, tile, halo } = fixture();
  halo[0].tile = {
    x: halo[0].neighborPosition.x,
    y: halo[0].neighborPosition.y,
    terrain: "plain",
    elevation: 0.99,
    drainage: 0.75,
  };

  const local = surfaceMoistureAt(state, tile);
  assert.equal(haloDrainageInflowAt(state, tile, halo), 0.75);
  assert.ok(surfaceMoistureWithHaloAt(state, tile, halo) > local + 0.09);

  halo[0].tile.flowTo = { x: halo[0].neighborPosition.x - 1, y: halo[0].neighborPosition.y };
  assert.equal(haloDrainageInflowAt(state, tile, halo), 0);
  assert.equal(surfaceMoistureWithHaloAt(state, tile, halo), local);

  delete halo[0].tile.flowTo;
  halo[0].tile.elevation = 0.7;
  assert.equal(haloDrainageInflowAt(state, tile, halo), 0);
  assert.equal(surfaceMoistureWithHaloAt(state, tile, halo), local);
});

test("independent upstream ghost tributaries combine at the same hex boundary cell", () => {
  const { state, tile, halo } = fixture();
  tile.elevation = 0.7;
  halo[0].tile = {
    x: halo[0].neighborPosition.x,
    y: halo[0].neighborPosition.y,
    terrain: "plain",
    elevation: 0.9,
    drainage: 0.35,
  };
  const second = {
    ...structuredClone(halo[0]),
    direction: "northEast",
    tile: {
      x: halo[0].neighborPosition.x,
      y: halo[0].neighborPosition.y,
      terrain: "plain",
      elevation: 0.95,
      drainage: 0.4,
    },
  };

  const strongestOnly = haloDrainageInflowAt(state, tile, halo);
  const combinedHalo = [...halo, second];
  const combined = haloDrainageInflowAt(state, tile, combinedHalo);
  assert.equal(strongestOnly, 0.35);
  assert.equal(combined, 0.75);
  assert.ok(surfaceMoistureWithHaloAt(state, tile, combinedHalo) > surfaceMoistureWithHaloAt(state, tile, halo));
  assert.ok(resourceRegrowthChanceWithHalo(state, tile, combinedHalo) > resourceRegrowthChanceWithHalo(state, tile, halo));
});

test("neighboring ghost woodland boosts depleted boundary forest regrowth without fabricating moisture", () => {
  const { state, tile, halo } = fixture();
  halo[0].tile = {
    x: halo[0].neighborPosition.x,
    y: halo[0].neighborPosition.y,
    terrain: "forest",
    elevation: 0.8,
    resource: { kind: "wood", amount: 10, maxAmount: 10 },
  };

  assert.equal(surfaceMoistureWithHaloAt(state, tile, halo), surfaceMoistureAt(state, tile));
  assert.ok(resourceRegrowthChanceWithHalo(state, tile, halo) > resourceRegrowthChance(state, tile));

  halo[0].tile.resource.amount = 0;
  assert.equal(resourceRegrowthChanceWithHalo(state, tile, halo), resourceRegrowthChance(state, tile));
});

test("neighboring ghost forage seeds matching boundary food regrowth without fabricating moisture", () => {
  const { state, tile, halo } = fixture();
  tile.terrain = "plain";
  tile.resource = { kind: "food", amount: 0, maxAmount: 10 };
  halo[0].tile = {
    x: halo[0].neighborPosition.x,
    y: halo[0].neighborPosition.y,
    terrain: "plain",
    elevation: 0.8,
    resource: { kind: "food", amount: 8, maxAmount: 10 },
  };

  const localMoisture = surfaceMoistureAt(state, tile);
  const localChance = resourceRegrowthChance(state, tile);
  assert.equal(surfaceMoistureWithHaloAt(state, tile, halo), localMoisture);
  assert.ok(resourceRegrowthChanceWithHalo(state, tile, halo) > localChance);

  halo[0].tile.resource = { kind: "wood", amount: 10, maxAmount: 10 };
  assert.equal(resourceRegrowthChanceWithHalo(state, tile, halo), localChance);
});

test("independent matching ghost stands combine bounded propagule pressure", () => {
  const { state, tile, halo } = fixture();
  tile.terrain = "plain";
  tile.resource = { kind: "food", amount: 0, maxAmount: 10 };
  halo[0].tile = {
    x: halo[0].neighborPosition.x,
    y: halo[0].neighborPosition.y,
    terrain: "plain",
    elevation: 0.8,
    resource: { kind: "food", amount: 5, maxAmount: 10 },
  };
  const second = {
    ...structuredClone(halo[0]),
    direction: "northEast",
    tile: {
      x: halo[0].neighborPosition.x,
      y: halo[0].neighborPosition.y,
      terrain: "plain",
      elevation: 0.8,
      resource: { kind: "food", amount: 5, maxAmount: 10 },
    },
  };

  const local = resourceRegrowthChance(state, tile);
  const oneStand = resourceRegrowthChanceWithHalo(state, tile, halo);
  const twoStands = resourceRegrowthChanceWithHalo(state, tile, [...halo, second]);
  assert.ok(oneStand > local);
  assert.ok(twoStands > oneStand);
  assert.ok(twoStands <= local + 0.04 + 1e-12);

  second.tile.resource = { kind: "wood", amount: 10, maxAmount: 10 };
  assert.equal(resourceRegrowthChanceWithHalo(state, tile, [...halo, second]), oneStand);
});

test("shared world wind strengthens propagules arriving from the upwind halo side", () => {
  const { state, tile, halo } = fixture();
  tile.terrain = "plain";
  tile.resource = { kind: "food", amount: 0, maxAmount: 10 };
  halo[0].tile = {
    x: halo[0].neighborPosition.x,
    y: halo[0].neighborPosition.y,
    terrain: "plain",
    elevation: 0.8,
    resource: { kind: "food", amount: 5, maxAmount: 10 },
  };

  const baseline = resourceRegrowthChanceWithHalo(state, tile, halo);
  const upwindFrame = environmentFrameForWind(tile, "west");
  const crosswindFrame = environmentFrameForWind(tile, "southEast");
  const upwind = sampleWorldWind(
    upwindFrame.worldSeed,
    upwindFrame.originX + tile.x,
    upwindFrame.originY + tile.y,
  );
  assert.equal(upwind.direction, "west");
  assert.ok(upwind.strength >= 0.2);

  const upwindChance = resourceRegrowthChanceWithHalo(state, tile, halo, upwindFrame);
  const crosswindChance = resourceRegrowthChanceWithHalo(state, tile, halo, crosswindFrame);
  assert.ok(upwindChance > baseline);
  assert.equal(crosswindChance, baseline);
  assert.ok(upwindChance <= resourceRegrowthChance(state, tile) + 0.04 + 1e-12);
  assert.equal(surfaceMoistureWithHaloAt(state, tile, halo), surfaceMoistureAt(state, tile));
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
