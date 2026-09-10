import assert from "node:assert/strict";
import test from "node:test";
import { hexGridDistance } from "../dist-ts/src/hex-grid.js";
import { surfaceMoistureAt } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("surface moisture uses axial hex distance for nearby water", () => {
  const state = createInitialWorld({ seed: 77123, width: 40, height: 24, regionId: "garden-1" });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    tile.elevation = 0.5;
    tile.drainage = 0;
    tile.erosionPressure = 0;
    delete tile.resource;
    delete tile.flowTo;
  }
  for (const agent of state.agents) {
    agent.autonomy = false;
    delete agent.task;
  }

  const center = { x: 19, y: 11 };
  const axialNeighbor = { x: 23, y: 7 };
  assert.equal(hexGridDistance(center, axialNeighbor), 4);
  assert.equal(
    Math.abs(center.x - axialNeighbor.x) + Math.abs(center.y - axialNeighbor.y),
    8,
    "fixture must distinguish axial hex distance from legacy Manhattan distance",
  );

  const dry = surfaceMoistureAt(state, center);
  const water = state.tiles[axialNeighbor.y * state.width + axialNeighbor.x];
  assert.ok(water);
  water.terrain = "water";
  water.elevation = 0;
  water.drainage = 1;

  const moist = surfaceMoistureAt(state, center);
  assert.ok(moist > dry + 0.15, `${moist} should materially exceed ${dry}`);
  assert.ok(
    Math.abs((moist - dry) - 0.16) < 1e-9,
    `distance-four axial water should contribute exactly 0.16 moisture, got ${moist - dry}`,
  );
});
