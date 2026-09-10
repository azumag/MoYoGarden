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

test("older live terrain cannot roll a fresher cached neighbor backwards", async () => {
  const mergeLiveTerrainWindow = await loadMerge();
  assert.equal(typeof mergeLiveTerrainWindow, "function", "terrain window merge helper is missing");

  const terrain = { chunks: [{
    regionId: "hex-q0-r1",
    origin: { x: 0, y: 240 },
    hexOrigin: { x: 10.39, y: 18 },
    axial: { q: 0, r: 1 },
    state: {
      width: 40,
      height: 24,
      tick: 24,
      revision: 31,
      tiles: [{ x: 8, y: 8, terrain: "forest", elevation: 0.61 }],
    },
  }] };
  const live = { chunks: [{
    regionId: "hex-q0-r1",
    state: {
      width: 40,
      height: 24,
      tick: 23,
      revision: 30,
      tiles: [{ x: 8, y: 8, terrain: "plain", elevation: 0.42 }],
      agents: [],
      structures: [],
    },
  }] };

  const merged = mergeLiveTerrainWindow(terrain, live);
  const chunk = merged.chunks[0];
  assert.equal(chunk.state.tick, 24);
  assert.equal(chunk.state.revision, 31);
  assert.deepEqual(chunk.state.tiles, [
    { x: 8, y: 8, terrain: "forest", elevation: 0.61 },
  ]);
  assert.deepEqual(chunk.hexOrigin, { x: 10.39, y: 18 });
});

test("same-tick terrain merge refuses an older revision", async () => {
  const mergeLiveTerrainWindow = await loadMerge();
  assert.equal(typeof mergeLiveTerrainWindow, "function", "terrain window merge helper is missing");

  const terrain = { chunks: [{
    regionId: "hex-q1-r-1",
    state: {
      width: 40,
      height: 24,
      tick: 40,
      revision: 52,
      tiles: [{ x: 9, y: 9, terrain: "hill", elevation: 0.73 }],
    },
  }] };
  const live = { chunks: [{
    regionId: "hex-q1-r-1",
    state: {
      width: 40,
      height: 24,
      tick: 40,
      revision: 51,
      tiles: [{ x: 9, y: 9, terrain: "plain", elevation: 0.44 }],
      agents: [],
      structures: [],
    },
  }] };

  const merged = mergeLiveTerrainWindow(terrain, live);
  assert.equal(merged.chunks[0].state.revision, 52);
  assert.equal(merged.chunks[0].state.tiles[0].terrain, "hill");
});

test("partial newer live terrain overlays valid cells without punching holes in cached terrain", async () => {
  const mergeLiveTerrainWindow = await loadMerge();
  assert.equal(typeof mergeLiveTerrainWindow, "function", "terrain window merge helper is missing");

  const terrain = { chunks: [{
    regionId: "hex-q0-r0",
    state: {
      width: 40,
      height: 24,
      tick: 50,
      revision: 60,
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
      tick: 51,
      revision: 61,
      tiles: [
        { x: 10, y: 10, terrain: "hill", elevation: 0.45 },
        { x: "bad", y: 10, terrain: "water", elevation: 0 },
      ],
    },
  }] };

  const merged = mergeLiveTerrainWindow(terrain, live);
  const state = merged.chunks[0].state;
  assert.equal(state.tick, 51);
  assert.equal(state.revision, 61);
  assert.deepEqual(state.tiles, [
    { x: 10, y: 10, terrain: "hill", elevation: 0.45 },
    { x: 11, y: 10, terrain: "forest", elevation: 0.5 },
  ]);
});

test("duplicate or fractional live cells cannot masquerade as a complete terrain refresh", async () => {
  const mergeLiveTerrainWindow = await loadMerge();
  assert.equal(typeof mergeLiveTerrainWindow, "function", "terrain window merge helper is missing");

  const terrain = { chunks: [{
    regionId: "hex-q0-r0",
    state: {
      width: 40,
      height: 24,
      tick: 70,
      revision: 80,
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
      tick: 71,
      revision: 81,
      tiles: [
        { x: 10, y: 10, terrain: "hill", elevation: 0.45 },
        { x: 10, y: 10, terrain: "water", elevation: 0.1 },
        { x: 11.5, y: 10, terrain: "plain", elevation: 0.2 },
      ],
    },
  }] };

  const merged = mergeLiveTerrainWindow(terrain, live);
  const state = merged.chunks[0].state;
  assert.equal(state.tick, 71);
  assert.equal(state.revision, 81);
  assert.deepEqual(state.tiles, [
    { x: 10, y: 10, terrain: "water", elevation: 0.1 },
    { x: 11, y: 10, terrain: "forest", elevation: 0.5 },
  ]);
});
