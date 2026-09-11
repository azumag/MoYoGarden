import assert from "node:assert/strict";
import test from "node:test";
import { surfaceMoistureWithHaloAt } from "../dist-ts/src/halo-environment.js";
import { buildHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { sampleWorldWind } from "../dist-ts/src/world-scale.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const WORLD_SEED = 424242;
const VEGETATION_VAPOR_GAIN = 0.025;
const FOOD_VAPOR_GAIN = 0.0125;
const EPSILON = 1e-12;

function clearedWorld() {
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
  return state;
}

function environmentFrameForWind(tile, direction) {
  for (let originY = -768; originY <= 768; originY += 16) {
    for (let originX = -768; originX <= 768; originX += 16) {
      const wind = sampleWorldWind(WORLD_SEED, originX + tile.x, originY + tile.y);
      if (wind.direction === direction && wind.strength >= 0.2) {
        return { worldSeed: WORLD_SEED, originX, originY };
      }
    }
  }
  assert.fail(`could not find deterministic ${direction} wind fixture`);
}

function windAt(tile, frame) {
  return sampleWorldWind(
    frame.worldSeed,
    frame.originX + tile.x,
    frame.originY + tile.y,
  );
}

function approximately(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) <= EPSILON,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

test("upwind ghost forest carries biomass-scaled evapotranspiration across a hex seam", () => {
  const state = clearedWorld();
  const link = buildHexHaloLinks(state, ["garden-1", "garden-2"], "garden-1")
    .filter((entry) => entry.direction === "east")[11];
  assert.ok(link);
  const receiver = state.tiles[link.sourcePosition.y * state.width + link.sourcePosition.x];
  assert.ok(receiver);

  const cover = 0.5;
  const halo = [{
    ...link,
    tile: {
      x: link.neighborPosition.x,
      y: link.neighborPosition.y,
      terrain: "forest",
      elevation: 0.8,
      drainage: 0,
      resource: { kind: "wood", amount: 10, maxAmount: 20 },
    },
  }];
  const frame = environmentFrameForWind(receiver, "west");
  const wind = windAt(receiver, frame);
  assert.equal(wind.direction, "west");

  const baseline = surfaceMoistureWithHaloAt(state, receiver, halo);
  const downwind = surfaceMoistureWithHaloAt(state, receiver, halo, frame);
  approximately(
    downwind - baseline,
    wind.strength * cover * VEGETATION_VAPOR_GAIN,
    "cross-region forest vapor should scale with shared wind and source biomass",
  );
});

test("local and cross-region forest use the same evapotranspiration rule", () => {
  const localState = clearedWorld();
  const localReceiver = localState.tiles[11 * localState.width + 19];
  const localSource = localState.tiles[11 * localState.width + 20];
  assert.ok(localReceiver);
  assert.ok(localSource);
  localSource.terrain = "forest";
  localSource.resource = { kind: "wood", amount: 15, maxAmount: 20 };

  const frame = environmentFrameForWind(localReceiver, "west");
  const wind = windAt(localReceiver, frame);
  const localBaseline = surfaceMoistureWithHaloAt(localState, localReceiver, []);
  const localDownwind = surfaceMoistureWithHaloAt(localState, localReceiver, [], frame);
  const expected = wind.strength * 0.75 * VEGETATION_VAPOR_GAIN;
  approximately(
    localDownwind - localBaseline,
    expected,
    "local forest vapor should use the biomass-scaled shared gain",
  );

  const haloState = clearedWorld();
  const link = buildHexHaloLinks(haloState, ["garden-1", "garden-2"], "garden-1")
    .filter((entry) => entry.direction === "east")[11];
  assert.ok(link);
  const haloReceiver = haloState.tiles[link.sourcePosition.y * haloState.width + link.sourcePosition.x];
  assert.ok(haloReceiver);
  const haloFrame = environmentFrameForWind(haloReceiver, "west");
  const haloWind = windAt(haloReceiver, haloFrame);
  const halo = [{
    ...link,
    tile: {
      x: link.neighborPosition.x,
      y: link.neighborPosition.y,
      terrain: "forest",
      elevation: 0.8,
      drainage: 0,
      resource: { kind: "wood", amount: 15, maxAmount: 20 },
    },
  }];
  const haloBaseline = surfaceMoistureWithHaloAt(haloState, haloReceiver, halo);
  const haloDownwind = surfaceMoistureWithHaloAt(haloState, haloReceiver, halo, haloFrame);
  approximately(
    haloDownwind - haloBaseline,
    haloWind.strength * 0.75 * VEGETATION_VAPOR_GAIN,
    "cross-region forest should use the same biomass-scaled vapor rule",
  );
});

test("food biomass carries weaker evapotranspiration through the same local and halo path", () => {
  const cover = 0.6;
  const localState = clearedWorld();
  const localReceiver = localState.tiles[11 * localState.width + 19];
  const localSource = localState.tiles[11 * localState.width + 20];
  assert.ok(localReceiver);
  assert.ok(localSource);
  localSource.resource = { kind: "food", amount: 12, maxAmount: 20 };

  const frame = environmentFrameForWind(localReceiver, "west");
  const wind = windAt(localReceiver, frame);
  const localBaseline = surfaceMoistureWithHaloAt(localState, localReceiver, []);
  const localDownwind = surfaceMoistureWithHaloAt(localState, localReceiver, [], frame);
  approximately(
    localDownwind - localBaseline,
    wind.strength * cover * FOOD_VAPOR_GAIN,
    "local food cover should return a smaller biomass-scaled vapor flux",
  );

  const haloState = clearedWorld();
  const link = buildHexHaloLinks(haloState, ["garden-1", "garden-2"], "garden-1")
    .filter((entry) => entry.direction === "east")[11];
  assert.ok(link);
  const haloReceiver = haloState.tiles[link.sourcePosition.y * haloState.width + link.sourcePosition.x];
  assert.ok(haloReceiver);
  const haloFrame = environmentFrameForWind(haloReceiver, "west");
  const haloWind = windAt(haloReceiver, haloFrame);
  const halo = [{
    ...link,
    tile: {
      x: link.neighborPosition.x,
      y: link.neighborPosition.y,
      terrain: "plain",
      elevation: 0.8,
      drainage: 0,
      resource: { kind: "food", amount: 12, maxAmount: 20 },
    },
  }];
  const haloBaseline = surfaceMoistureWithHaloAt(haloState, haloReceiver, halo);
  const haloDownwind = surfaceMoistureWithHaloAt(haloState, haloReceiver, halo, haloFrame);
  approximately(
    haloDownwind - haloBaseline,
    haloWind.strength * cover * FOOD_VAPOR_GAIN,
    "cross-region food cover should use the same weaker vapor rule",
  );
});

test("an exact ghost owner suppresses rectangular compatibility-cell forest vapor", () => {
  const state = clearedWorld();
  const link = buildHexHaloLinks(state, ["garden-1", "garden-2"], "garden-1")
    .filter((entry) => entry.direction === "east")[11];
  assert.ok(link);
  const receiver = state.tiles[link.sourcePosition.y * state.width + link.sourcePosition.x];
  assert.ok(receiver);
  const compatibilityCell = state.tiles[
    receiver.y * state.width + receiver.x + 1
  ];
  assert.ok(compatibilityCell);
  compatibilityCell.terrain = "forest";
  compatibilityCell.resource = { kind: "wood", amount: 20, maxAmount: 20 };

  const halo = [{
    ...link,
    tile: {
      x: link.neighborPosition.x,
      y: link.neighborPosition.y,
      terrain: "plain",
      elevation: 0.8,
      drainage: 0,
    },
  }];
  const frame = environmentFrameForWind(receiver, "west");
  assert.equal(
    surfaceMoistureWithHaloAt(state, receiver, halo, frame),
    surfaceMoistureWithHaloAt(state, receiver, halo),
    "the exact ghost cell should remain authoritative over the rectangular compatibility cell",
  );
});
