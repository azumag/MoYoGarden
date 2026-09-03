import assert from "node:assert/strict";
import test from "node:test";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import {
  ensureWorldExtent,
  TARGET_WORLD_HEIGHT,
  TARGET_WORLD_WIDTH,
} from "../dist-ts/src/world-scale.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("legacy default worlds gain a deterministic coordinate-stable frontier", () => {
  const legacy = createInitialWorld({ seed: 98765, width: 32, height: 20 });
  const originalTiles = new Map(legacy.tiles.map((tile) => [`${tile.x}:${tile.y}`, structuredClone(tile)]));
  const originalAgents = structuredClone(legacy.agents);

  assert.equal(ensureWorldExtent(legacy), true);
  assert.equal(legacy.width, TARGET_WORLD_WIDTH);
  assert.equal(legacy.height, TARGET_WORLD_HEIGHT);
  assert.equal(legacy.tiles.length, TARGET_WORLD_WIDTH * TARGET_WORLD_HEIGHT);
  assert.deepEqual(legacy.agents, originalAgents);

  for (const [key, tile] of originalTiles) {
    const [x, y] = key.split(":").map(Number);
    assert.deepEqual(legacy.tiles[y * legacy.width + x], tile);
  }

  const frontier = legacy.tiles.filter((tile) => tile.x >= 32 || tile.y >= 20);
  assert.ok(frontier.length > 0);
  assert.ok(frontier.every((tile) => Number.isFinite(tile.elevation)));
  assert.ok(new Set(frontier.map((tile) => tile.terrain)).size >= 2);
  assert.equal(ensureWorldExtent(legacy), false);
});

test("runtime expands persisted default worlds but respects explicit compact test worlds", () => {
  const persisted = createInitialWorld({ seed: 24680, width: 32, height: 20 });
  const expanded = new WorldRuntime({ state: persisted }).snapshot();
  assert.equal(expanded.width, TARGET_WORLD_WIDTH);
  assert.equal(expanded.height, TARGET_WORLD_HEIGHT);

  const compact = new WorldRuntime({ seed: 24680, width: 16, height: 12 }).snapshot();
  assert.equal(compact.width, 16);
  assert.equal(compact.height, 12);
});
