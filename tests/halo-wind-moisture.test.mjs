import assert from "node:assert/strict";
import test from "node:test";
import { surfaceMoistureWithHaloAt } from "../dist-ts/src/halo-environment.js";
import { buildHexHaloLinks } from "../dist-ts/src/hex-halo.js";
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
  tile.elevation = 0.8;
  const halo = [{
    ...link,
    tile: {
      x: link.neighborPosition.x,
      y: link.neighborPosition.y,
      terrain: "water",
      elevation: 0,
    },
  }];
  return { state, tile, halo };
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

function windAt(tile, frame) {
  return sampleWorldWind(
    frame.worldSeed,
    frame.originX + tile.x,
    frame.originY + tile.y,
  );
}

test("upwind ghost water carries a bounded windborne moisture bonus across the hex halo", () => {
  const { state, tile, halo } = fixture();
  const baseline = surfaceMoistureWithHaloAt(state, tile, halo);
  const upwindFrame = environmentFrameForWind(tile, "west");
  const crosswindFrame = environmentFrameForWind(tile, "southEast");

  const upwindWind = windAt(tile, upwindFrame);
  assert.equal(upwindWind.direction, "west");
  assert.ok(upwindWind.strength >= 0.2);

  const upwind = surfaceMoistureWithHaloAt(state, tile, halo, upwindFrame);
  const crosswind = surfaceMoistureWithHaloAt(state, tile, halo, crosswindFrame);
  assert.ok(upwind > baseline);
  assert.equal(crosswind, baseline);
  assert.ok(upwind - baseline <= 0.08 + 1e-12);
});

test("local and cross-region upwind water receive the same vapor rule", () => {
  const haloCase = fixture();
  const haloFrame = environmentFrameForWind(haloCase.tile, "west");
  const haloWind = windAt(haloCase.tile, haloFrame);
  const haloBaseline = surfaceMoistureWithHaloAt(haloCase.state, haloCase.tile, haloCase.halo);
  const haloUpwind = surfaceMoistureWithHaloAt(
    haloCase.state,
    haloCase.tile,
    haloCase.halo,
    haloFrame,
  );
  assert.ok(haloUpwind > haloBaseline);
  assert.ok(
    Math.abs((haloUpwind - haloBaseline) - haloWind.strength * 0.08) < 1e-12,
    "cross-region upwind water should add wind strength times the shared vapor gain",
  );

  const localCase = fixture();
  const localTile = localCase.state.tiles[11 * localCase.state.width + 19];
  const localWater = localCase.state.tiles[11 * localCase.state.width + 20];
  assert.ok(localTile);
  assert.ok(localWater);
  localTile.terrain = "plain";
  localTile.elevation = 0.8;
  delete localTile.resource;
  localWater.terrain = "water";
  localWater.elevation = 0;
  delete localWater.resource;

  const localFrame = environmentFrameForWind(localTile, "west");
  const localWind = windAt(localTile, localFrame);
  const localBaseline = surfaceMoistureWithHaloAt(localCase.state, localTile, []);
  const localUpwind = surfaceMoistureWithHaloAt(localCase.state, localTile, [], localFrame);
  assert.ok(localUpwind > localBaseline);
  assert.ok(
    Math.abs((localUpwind - localBaseline) - localWind.strength * 0.08) < 1e-12,
    "local upwind water should use the identical shared vapor gain",
  );

  const compatibilityCell = haloCase.state.tiles[
    haloCase.tile.y * haloCase.state.width + haloCase.tile.x + 1
  ];
  assert.ok(compatibilityCell);
  compatibilityCell.terrain = "water";
  haloCase.halo[0].tile.terrain = "plain";
  assert.equal(
    surfaceMoistureWithHaloAt(haloCase.state, haloCase.tile, haloCase.halo, haloFrame),
    surfaceMoistureWithHaloAt(haloCase.state, haloCase.tile, haloCase.halo),
    "an exact ghost owner must suppress directional vapor from the rectangular compatibility cell",
  );
});
