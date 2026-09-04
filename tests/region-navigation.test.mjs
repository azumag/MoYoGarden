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

const hexLayout = [
  "garden-c",
  "garden-e",
  "garden-ne",
  "garden-nw",
  "garden-w",
  "garden-sw",
  "garden-se",
].map((id, index) => ({
  id,
  origin: { x: index * 40, y: 0 },
  extent: { width: 40, height: 24 },
}));

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

test("region prefetch resolves all six directions from the same logical hex topology", () => {
  assert.equal(resolveRegionPrefetch(hexLayout, "garden-c", { x: 10, z: 0 }, 6), null);
  assert.deepEqual(resolveRegionPrefetch(hexLayout, "garden-c", { x: 14.5, z: 0 }, 6), {
    regionId: "garden-e",
    direction: "east",
  });
  assert.deepEqual(resolveRegionPrefetch(hexLayout, "garden-c", { x: -14.5, z: 0 }, 6), {
    regionId: "garden-w",
    direction: "west",
  });
  assert.deepEqual(resolveRegionPrefetch(hexLayout, "garden-c", { x: 1, z: -7 }, 6), {
    regionId: "garden-ne",
    direction: "northEast",
  });
  assert.deepEqual(resolveRegionPrefetch(hexLayout, "garden-c", { x: -1, z: -7 }, 6), {
    regionId: "garden-nw",
    direction: "northWest",
  });
  assert.deepEqual(resolveRegionPrefetch(hexLayout, "garden-c", { x: 1, z: 7 }, 6), {
    regionId: "garden-se",
    direction: "southEast",
  });
  assert.deepEqual(resolveRegionPrefetch(hexLayout, "garden-c", { x: -1, z: 7 }, 6), {
    regionId: "garden-sw",
    direction: "southWest",
  });
});

test("region prefetch no longer uses physical same-row adjacency as a topology fallback", () => {
  assert.equal(resolveRegionPrefetch(extendedLayout, "garden-2", { x: 14.5, z: 0 }, 6), null);
  assert.deepEqual(resolveRegionPrefetch(extendedLayout, "garden-2", { x: -14.5, z: 0 }, 6), {
    regionId: "garden-3",
    direction: "west",
  });
});

test("region prefetch leaves missing hex neighbors cold", () => {
  assert.deepEqual(resolveRegionPrefetch(layout, "garden-1", { x: 1, z: -7 }, 6), {
    regionId: "garden-3",
    direction: "northEast",
  });
  assert.equal(resolveRegionPrefetch(layout, "garden-1", { x: -1, z: -7 }, 6), null);
  assert.equal(resolveRegionPrefetch(layout, "garden-1", { x: 1, z: 7 }, 6), null);
  assert.equal(resolveRegionPrefetch(layout, "garden-3", { x: 18, z: 0 }, 6), null);
});
