import test from "node:test";
import assert from "node:assert/strict";
import { resolveRegionPrefetch, resolveRegionRebase } from "../public/client/region-navigation.js";

const layout = [
  { id: "garden-1", origin: { x: 0, y: 0 }, extent: { width: 40, height: 24 } },
  { id: "garden-2", origin: { x: 40, y: 0 }, extent: { width: 40, height: 24 } },
  { id: "garden-3", origin: { x: 80, y: 0 }, extent: { width: 40, height: 24 } },
];

const extendedLayout = [
  { id: "garden-0", origin: { x: 0, y: 0 }, extent: { width: 40, height: 24 } },
  { id: "garden-1", origin: { x: 40, y: 0 }, extent: { width: 40, height: 24 } },
  { id: "garden-2", origin: { x: 80, y: 0 }, extent: { width: 40, height: 24 } },
  { id: "garden-3", origin: { x: 120, y: 0 }, extent: { width: 40, height: 24 } },
  { id: "garden-4", origin: { x: 160, y: 0 }, extent: { width: 40, height: 24 } },
];

test("region rebase stays within the current chunk until the target crosses its boundary", () => {
  assert.equal(resolveRegionRebase(layout, "garden-2", { x: 19.99, z: 0 }), null);
  assert.equal(resolveRegionRebase(layout, "garden-2", { x: -20, z: 0 }), null);
});

test("region rebase shifts an eastbound camera into the next chunk without moving globally", () => {
  assert.deepEqual(resolveRegionRebase(layout, "garden-2", { x: 20.25, z: 3 }), {
    regionId: "garden-3",
    offsetX: 40,
    offsetZ: 0,
    target: { x: -19.75, z: 3 },
  });
});

test("region rebase shifts a westbound camera into the previous chunk", () => {
  assert.deepEqual(resolveRegionRebase(layout, "garden-2", { x: -20.25, z: -4 }), {
    regionId: "garden-1",
    offsetX: -40,
    offsetZ: 0,
    target: { x: 19.75, z: -4 },
  });
});

test("region rebase ignores targets outside every configured chunk", () => {
  assert.equal(resolveRegionRebase(layout, "garden-1", { x: -20.5, z: 0 }), null);
  assert.equal(resolveRegionRebase(layout, "garden-3", { x: 60.5, z: 0 }), null);
});

test("region prefetch warms the immediate neighbor only when the camera nears an edge", () => {
  assert.equal(resolveRegionPrefetch(extendedLayout, "garden-2", { x: 10, z: 0 }, 6), null);
  assert.deepEqual(resolveRegionPrefetch(extendedLayout, "garden-2", { x: 14.5, z: 0 }, 6), {
    regionId: "garden-3",
    direction: "east",
  });
  assert.deepEqual(resolveRegionPrefetch(extendedLayout, "garden-2", { x: -14.5, z: 0 }, 6), {
    regionId: "garden-1",
    direction: "west",
  });
});

test("region prefetch works at the configured world edges when a neighbor exists", () => {
  assert.deepEqual(resolveRegionPrefetch(layout, "garden-2", { x: 18, z: 0 }, 6), {
    regionId: "garden-3",
    direction: "east",
  });
  assert.deepEqual(resolveRegionPrefetch(layout, "garden-2", { x: -18, z: 0 }, 6), {
    regionId: "garden-1",
    direction: "west",
  });
  assert.deepEqual(resolveRegionPrefetch(layout, "garden-1", { x: 18, z: 0 }, 6), {
    regionId: "garden-2",
    direction: "east",
  });
  assert.equal(resolveRegionPrefetch(layout, "garden-1", { x: -18, z: 0 }, 6), null);
});
