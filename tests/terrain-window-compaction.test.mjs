import assert from "node:assert/strict";
import test from "node:test";
import { enrichRegionWindowPayload } from "../dist-ts/src/worker-entry.js";

function rectangularTerrainState() {
  return {
    regionId: "garden-1",
    width: 40,
    height: 24,
    tick: 12,
    revision: 34,
    tiles: Array.from({ length: 24 }, (_, y) =>
      Array.from({ length: 40 }, (_, x) => ({ x, y, terrain: "plain", elevation: 0.5 })),
    ).flat(),
  };
}

test("terrain-only region windows compact the center to the active hex footprint", () => {
  const payload = {
    centerRegion: "garden-1",
    radius: 0,
    chunks: [{ regionId: "garden-1", state: rectangularTerrainState() }],
  };

  const live = enrichRegionWindowPayload(payload, ["garden-1", "garden-2", "garden-3"]);
  assert.equal(live.chunks[0].state.tiles.length, 960);

  const terrain = enrichRegionWindowPayload(
    payload,
    ["garden-1", "garden-2", "garden-3"],
    { compactCenter: true },
  );
  assert.equal(terrain.chunks[0].state.tiles.length, 397);
  assert.equal(terrain.chunks[0].state.tiles.some((tile) => tile.x === 0 && tile.y === 0), false);
  assert.equal(terrain.chunks[0].state.tiles.some((tile) => tile.x === 19 && tile.y === 11), true);
});
