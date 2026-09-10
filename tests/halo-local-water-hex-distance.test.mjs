import assert from "node:assert/strict";
import test from "node:test";
import { surfaceMoistureWithHaloAt } from "../dist-ts/src/halo-environment.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function fixture() {
  const state = createInitialWorld({ seed: 9402, width: 40, height: 24, regionId: "garden-1" });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    delete tile.resource;
    tile.elevation = 0.8;
    tile.drainage = 0;
    delete tile.flowTo;
    tile.erosionPressure = 0;
  }
  return state;
}

test("halo-aware local moisture uses axial hex distance in every direction", () => {
  const state = fixture();
  const target = { x: 15, y: 15 };
  const water = state.tiles[(target.y - 4) * state.width + (target.x + 4)];
  assert.ok(water);
  water.terrain = "water";

  const baselineState = fixture();
  const baseline = surfaceMoistureWithHaloAt(baselineState, target, []);
  const withWater = surfaceMoistureWithHaloAt(state, target, []);

  // Relative (+4,-4) is exactly four axial hexes away but eight Manhattan
  // steps. The halo-aware moisture path must match the core simulation metric:
  // influence=(5-4)/4=0.25, moisture contribution=0.25*0.64=0.16.
  assert.ok(Math.abs((withWater - baseline) - 0.16) < 1e-12);
});
