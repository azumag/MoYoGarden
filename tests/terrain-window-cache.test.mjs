import assert from "node:assert/strict";
import test from "node:test";

async function loadMerge() {
  try {
    const module = await import("../public/client/terrain-window-cache.js");
    return module.mergeLiveTerrainWindow;
  } catch {
    return undefined;
  }
}

test("live terrain refresh preserves radius-two placement metadata", async () => {
  const mergeLiveTerrainWindow = await loadMerge();
  assert.equal(typeof mergeLiveTerrainWindow, "function", "terrain window merge helper is missing");

  const terrain = { chunks: [{
    regionId: "hex-q-1-r0",
    origin: { x: 280, y: 0 },
    hexOrigin: { x: -20.78, y: 0 },
    axial: { q: -1, r: 0 },
    state: { width: 40, height: 24, tick: 10, revision: 10, tiles: [{ x: 1, y: 1, terrain: "plain" }] },
  }] };
  const live = { chunks: [{
    regionId: "hex-q-1-r0",
    origin: { x: 120, y: 0 },
    hexOrigin: { x: -20.78, y: 0 },
    state: {
      width: 40,
      height: 24,
      tick: 11,
      revision: 11,
      tiles: [{ x: 1, y: 1, terrain: "forest" }],
      agents: [{ id: "a" }],
      structures: [{ id: "s" }],
    },
  }] };

  const merged = mergeLiveTerrainWindow(terrain, live);
  const chunk = merged.chunks[0];
  assert.deepEqual(chunk.origin, { x: 280, y: 0 });
  assert.deepEqual(chunk.hexOrigin, { x: -20.78, y: 0 });
  assert.deepEqual(chunk.axial, { q: -1, r: 0 });
  assert.equal(chunk.state.tick, 11);
  assert.equal(chunk.state.revision, 11);
  assert.equal(chunk.state.tiles[0].terrain, "forest");
  assert.equal("agents" in chunk.state, false);
  assert.equal("structures" in chunk.state, false);
});
