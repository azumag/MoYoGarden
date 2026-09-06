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

test("upwind ghost water carries a bounded windborne moisture bonus across the hex halo", () => {
  const { state, tile, halo } = fixture();
  const baseline = surfaceMoistureWithHaloAt(state, tile, halo);
  const upwindFrame = environmentFrameForWind(tile, "west");
  const crosswindFrame = environmentFrameForWind(tile, "southEast");

  const upwindWind = sampleWorldWind(
    upwindFrame.worldSeed,
    upwindFrame.originX + tile.x,
    upwindFrame.originY + tile.y,
  );
  assert.equal(upwindWind.direction, "west");
  assert.ok(upwindWind.strength >= 0.2);

  const upwind = surfaceMoistureWithHaloAt(state, tile, halo, upwindFrame);
  const crosswind = surfaceMoistureWithHaloAt(state, tile, halo, crosswindFrame);
  assert.ok(upwind > baseline);
  assert.equal(crosswind, baseline);
  assert.ok(upwind - baseline <= 0.08 + 1e-12);
});
