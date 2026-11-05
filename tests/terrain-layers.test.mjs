import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld, ensureTileTerrainLayers } from "../dist-ts/src/world.js";

test("terrain layers satisfy invariant for new world and after erosion ticks", () => {
  const state = createInitialWorld({ seed: 424242, width: 40, height: 24, regionId: "garden-1" });
  const check = (s) => {
    for (const tile of s.tiles) {
      if (tile.terrain === "water") continue;
      const bedrock = tile.bedrockElevation ?? 0;
      const soil = tile.soilThickness ?? 0;
      const elevation = tile.elevation ?? 0;
      assert.ok(Math.abs(bedrock + soil - elevation) < 1e-12,
        `invariant broken at (${tile.x},${tile.y}): ${bedrock} + ${soil} != ${elevation}`);
    }
  };
  check(state);
  let s = state;
  for (let i = 0; i < 130; i += 1) {
    s = simulate(s).state;
  }
  check(s);
});

test("water tiles are normalized to zero elevation and layers", () => {
  const state = createInitialWorld({ seed: 424242, width: 40, height: 24, regionId: "garden-1" });
  ensureTileTerrainLayers(state);
  for (const tile of state.tiles) {
    if (tile.terrain !== "water") continue;
    assert.equal(tile.elevation, 0);
    assert.equal(tile.bedrockElevation, 0);
    assert.equal(tile.soilThickness, 0);
  }
});

test("ensureTileTerrainLayers is idempotent", () => {
  const state = createInitialWorld({ seed: 424242, width: 40, height: 24, regionId: "garden-1" });
  ensureTileTerrainLayers(state);
  const before = structuredClone(state.tiles.map((t) => ({ x: t.x, y: t.y, e: t.elevation, b: t.bedrockElevation, s: t.soilThickness, terrain: t.terrain })));
  ensureTileTerrainLayers(state);
  const after = state.tiles.map((t) => ({ x: t.x, y: t.y, e: t.elevation, b: t.bedrockElevation, s: t.soilThickness, terrain: t.terrain }));
  assert.deepEqual(after, before);
});
