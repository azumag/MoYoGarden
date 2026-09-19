import assert from "node:assert/strict";
import test from "node:test";

import { mergeLiveTerrainWindow } from "../public/client/terrain-window-cache.js";

test("malformed live terrain cannot flatten or erase cached seam cells", () => {
  const terrain = { chunks: [{
    regionId: "hex-q0-r0",
    state: {
      width: 40,
      height: 24,
      tick: 120,
      revision: 130,
      tiles: [
        { x: 10, y: 10, terrain: "plain", elevation: 0.4 },
        { x: 11, y: 10, terrain: "forest", elevation: 0.5 },
      ],
    },
  }] };
  const live = { chunks: [{
    regionId: "hex-q0-r0",
    state: {
      width: 40,
      height: 24,
      tick: 121,
      revision: 131,
      tiles: [
        // Terrain classification is valid but this partial response omitted
        // elevation. Keep the last-known seam height while accepting the newer
        // terrain type.
        { x: 10, y: 10, terrain: "hill" },
        // A coordinate without a terrain classification is malformed and must
        // not erase the cached cell even though the coordinate itself is valid.
        { x: 11, y: 10, elevation: 0.9 },
      ],
    },
  }] };

  const merged = mergeLiveTerrainWindow(terrain, live);
  assert.equal(merged.chunks[0].state.tick, 121);
  assert.equal(merged.chunks[0].state.revision, 131);
  assert.deepEqual(merged.chunks[0].state.tiles, [
    { x: 10, y: 10, terrain: "hill", elevation: 0.4 },
    { x: 11, y: 10, terrain: "forest", elevation: 0.5 },
  ]);
});
