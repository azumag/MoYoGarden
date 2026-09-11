import assert from "node:assert/strict";
import test from "node:test";

import { mergeLiveTerrainWindow } from "../public/client/terrain-window-cache.js";

test("live-only region is carried until the slower terrain window catches up", () => {
  const terrain = {
    chunks: [{
      regionId: "hex-q0-r0",
      hexOrigin: { x: 0, y: 0 },
      axial: { q: 0, r: 0 },
      state: {
        width: 40,
        height: 24,
        tick: 100,
        revision: 120,
        tiles: [{ x: 10, y: 10, terrain: "plain", elevation: 0.4 }],
      },
    }],
  };
  const live = {
    chunks: [{
      regionId: "hex-q1-r0",
      origin: { x: 40, y: 0 },
      hexOrigin: { x: 20.78, y: 0 },
      axial: { q: 1, r: 0 },
      state: {
        width: 40,
        height: 24,
        tick: 101,
        revision: 121,
        tiles: [
          { x: 9, y: 9, terrain: "forest", elevation: 0.51 },
          { x: "bad", y: 10, terrain: "water", elevation: 0 },
        ],
        agents: [{ id: "a" }],
        structures: [{ id: "s" }],
      },
    }],
  };

  const merged = mergeLiveTerrainWindow(terrain, live);
  assert.equal(merged.chunks.length, 2);
  const carried = merged.chunks[1];
  assert.equal(carried.regionId, "hex-q1-r0");
  assert.deepEqual(carried.hexOrigin, { x: 20.78, y: 0 });
  assert.deepEqual(carried.axial, { q: 1, r: 0 });
  assert.deepEqual(carried.state.tiles, [
    { x: 9, y: 9, terrain: "forest", elevation: 0.51 },
  ]);
  assert.equal("agents" in carried.state, false);
  assert.equal("structures" in carried.state, false);
});

test("live-only region without hex placement metadata is ignored", () => {
  const terrain = { chunks: [] };
  const live = {
    chunks: [{
      regionId: "hex-q1-r0",
      state: {
        width: 40,
        height: 24,
        tick: 1,
        revision: 1,
        tiles: [{ x: 1, y: 1, terrain: "plain", elevation: 0.2 }],
      },
    }],
  };

  assert.deepEqual(mergeLiveTerrainWindow(terrain, live), terrain);
});
