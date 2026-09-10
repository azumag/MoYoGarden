import assert from "node:assert/strict";
import test from "node:test";
import { surfaceMoistureWithHaloAt } from "../dist-ts/src/halo-environment.js";
import { buildHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function fixture() {
  const state = createInitialWorld({ seed: 9302, width: 40, height: 24, regionId: "garden-1" });
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
  const halo = [{
    ...link,
    tile: {
      x: link.neighborPosition.x,
      y: link.neighborPosition.y,
      terrain: "water",
      elevation: 0,
    },
  }];
  return { state, link, halo };
}

test("depth-1 ghost water keeps the local moisture radius continuous inland", () => {
  const { state, link, halo } = fixture();
  const target = { x: link.sourcePosition.x - 2, y: link.sourcePosition.y };
  assert.ok(state.tiles[target.y * state.width + target.x]);

  const baseline = surfaceMoistureWithHaloAt(state, target, []);
  const withHalo = surfaceMoistureWithHaloAt(state, target, halo);

  // The ghost is one step beyond the boundary source, so this target is three
  // hexes from water: influence=(5-3)/4=0.5, moisture contribution=0.5*0.64.
  assert.ok(Math.abs((withHalo - baseline) - 0.32) < 1e-12);
});

test("ghost water does not leak past the shared four-hex moisture radius", () => {
  const { state, link, halo } = fixture();
  const target = { x: link.sourcePosition.x - 4, y: link.sourcePosition.y };
  assert.ok(state.tiles[target.y * state.width + target.x]);

  assert.equal(
    surfaceMoistureWithHaloAt(state, target, halo),
    surfaceMoistureWithHaloAt(state, target, []),
  );
});
