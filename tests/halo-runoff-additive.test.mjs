import assert from "node:assert/strict";
import test from "node:test";
import {
  haloDrainageInflowAt,
  surfaceMoistureWithHaloAt,
} from "../dist-ts/src/halo-environment.js";
import { buildHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { surfaceMoistureAt } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function fixture() {
  const state = createInitialWorld({ seed: 9401, width: 40, height: 24, regionId: "garden-1" });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    delete tile.resource;
    delete tile.flowTo;
    tile.elevation = 0.8;
    tile.drainage = 0;
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
  tile.drainage = 0.4;

  const halo = [{
    ...link,
    tile: {
      x: link.neighborPosition.x,
      y: link.neighborPosition.y,
      terrain: "plain",
      elevation: 0.99,
      drainage: 0.5,
    },
  }];
  return { state, tile, halo };
}

test("local catchment and cross-region tributary accumulate before runoff normalization", () => {
  const { state, tile, halo } = fixture();
  const local = surfaceMoistureAt(state, tile);
  const haloAware = surfaceMoistureWithHaloAt(state, tile, halo);

  assert.equal(haloDrainageInflowAt(state, tile, halo), 0.5);
  assert.ok(Math.abs((haloAware - local) - 0.07) < 1e-12);

  tile.drainage = 0.8;
  const saturatedLocal = surfaceMoistureAt(state, tile);
  const saturatedHaloAware = surfaceMoistureWithHaloAt(state, tile, halo);
  assert.ok(Math.abs((saturatedHaloAware - saturatedLocal) - 0.028) < 1e-12);
});
