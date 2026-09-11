import assert from "node:assert/strict";
import test from "node:test";

import { mergeLiveTerrainWindow } from "../public/client/terrain-window-cache.js";

function cachedState() {
  return {
    chunks: [{
      regionId: "hex-q0-r0",
      state: {
        width: 40,
        height: 24,
        tick: 120,
        revision: 130,
        tiles: [{ x: 10, y: 10, terrain: "forest", elevation: 0.61 }],
      },
    }],
  };
}

function liveState(version = {}) {
  return {
    chunks: [{
      regionId: "hex-q0-r0",
      state: {
        width: 40,
        height: 24,
        ...version,
        tiles: [{ x: 10, y: 10, terrain: "plain", elevation: 0.42 }],
      },
    }],
  };
}

test("versioned terrain cache rejects a live payload that omits tick", () => {
  const terrain = cachedState();
  const merged = mergeLiveTerrainWindow(terrain, liveState({ revision: 131 }));

  assert.deepEqual(merged.chunks[0].state, terrain.chunks[0].state);
});

test("equal-tick terrain cache rejects a live payload that omits revision", () => {
  const terrain = cachedState();
  const merged = mergeLiveTerrainWindow(terrain, liveState({ tick: 120 }));

  assert.deepEqual(merged.chunks[0].state, terrain.chunks[0].state);
});

test("a strictly newer live tick may advance terrain even without revision", () => {
  const terrain = cachedState();
  const merged = mergeLiveTerrainWindow(terrain, liveState({ tick: 121 }));

  assert.equal(merged.chunks[0].state.tick, 121);
  assert.equal(merged.chunks[0].state.revision, 130);
  assert.deepEqual(merged.chunks[0].state.tiles, [
    { x: 10, y: 10, terrain: "plain", elevation: 0.42 },
  ]);
});
