import test from "node:test";
import assert from "node:assert/strict";
import { regionMetaUrl, resolveRegionPrefetch, resolveRegionRebase } from "../public/client/region-navigation.js";

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

const hexWidth = 12 * Math.sqrt(3);
const hexLayout = [
  { id: "garden-c", axial: { q: 0, r: 0 }, hexOrigin: { x: 0, y: 0 } },
  { id: "garden-e", axial: { q: 1, r: 0 }, hexOrigin: { x: hexWidth, y: 0 } },
  { id: "garden-ne", axial: { q: 1, r: -1 }, hexOrigin: { x: hexWidth / 2, y: -18 } },
  { id: "garden-nw", axial: { q: 0, r: -1 }, hexOrigin: { x: -hexWidth / 2, y: -18 } },
  { id: "garden-w", axial: { q: -1, r: 0 }, hexOrigin: { x: -hexWidth, y: 0 } },
  { id: "garden-sw", axial: { q: -1, r: 1 }, hexOrigin: { x: -hexWidth / 2, y: 18 } },
  { id: "garden-se", axial: { q: 0, r: 1 }, hexOrigin: { x: hexWidth / 2, y: 18 } },
].map((entry, index) => ({
  ...entry,
  origin: { x: index * 40, y: 0 },
  extent: { width: 40, height: 24 },
}));

test("region metadata requests are scoped to the current bounded hex window", () => {
  assert.equal(regionMetaUrl("garden-1", 1), "/api/meta?region=garden-1&radius=1");
  assert.equal(regionMetaUrl("hex-q10-r-4", 9), "/api/meta?region=hex-q10-r-4&radius=4");
});

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test("legacy physical rebase stays within the current chunk until the target crosses its boundary", () => {
  assert.equal(resolveRegionRebase(layout, "garden-2", { x: 19.99, z: 0 }), null);
  assert.equal(resolveRegionRebase(layout, "garden-2", { x: -20, z: 0 }), null);
});

test("legacy physical rebase shifts an eastbound camera into the next chunk", () => {
  assert.deepEqual(resolveRegionRebase(layout, "garden-2", { x: 20.25, z: 3 }), {
    regionId: "garden-3",
    offsetX: 40,
    offsetZ: 0,
    target: { x: -19.75, z: 3 },
  });
});

test("legacy physical rebase shifts a westbound camera into the previous chunk", () => {
  assert.deepEqual(resolveRegionRebase(layout, "garden-2", { x: -20.25, z: -4 }), {
    regionId: "garden-1",
    offsetX: -40,
    offsetZ: 0,
    target: { x: 19.75, z: -4 },
  });
});

test("legacy physical rebase ignores targets outside every configured chunk", () => {
  assert.equal(resolveRegionRebase(layout, "garden-1", { x: -20.5, z: 0 }), null);
  assert.equal(resolveRegionRebase(layout, "garden-3", { x: 60.5, z: 0 }), null);
});

test("hex rebase crosses each of the six logical sides using hex origins", () => {
  assert.equal(resolveRegionRebase(hexLayout, "garden-c", { x: 0, z: 0 }), null);
  assert.equal(resolveRegionRebase(hexLayout, "garden-c", { x: hexWidth / 2, z: 0 }), null);

  for (const neighbor of hexLayout.slice(1)) {
    const target = {
      x: neighbor.hexOrigin.x * 0.51,
      z: neighbor.hexOrigin.y * 0.51,
    };
    const transition = resolveRegionRebase(hexLayout, "garden-c", target);
    assert.ok(transition, `missing transition to ${neighbor.id}`);
    assert.equal(transition.regionId, neighbor.id);
    close(transition.offsetX, neighbor.hexOrigin.x);
    close(transition.offsetZ, neighbor.hexOrigin.y);
    close(transition.target.x, target.x - neighbor.hexOrigin.x);
    close(transition.target.z, target.z - neighbor.hexOrigin.y);
  }
});

test("hex rebase does not skip across a missing immediate neighbor", () => {
  const partial = hexLayout.filter((entry) => !["garden-nw", "garden-w", "garden-sw"].includes(entry.id));
  const missing = hexLayout.find((entry) => entry.id === "garden-nw");
  assert.ok(missing);
  assert.equal(resolveRegionRebase(partial, "garden-c", {
    x: missing.hexOrigin.x * 0.51,
    z: missing.hexOrigin.y * 0.51,
  }), null);
});

test("region prefetch resolves all six directions from axial metadata near hex sides", () => {
  assert.equal(resolveRegionPrefetch(hexLayout, "garden-c", { x: 0, z: 0 }, 6), null);
  for (const neighbor of hexLayout.slice(1)) {
    const expectedDirection = {
      "garden-e": "east",
      "garden-ne": "northEast",
      "garden-nw": "northWest",
      "garden-w": "west",
      "garden-sw": "southWest",
      "garden-se": "southEast",
    }[neighbor.id];
    assert.deepEqual(resolveRegionPrefetch(hexLayout, "garden-c", {
      x: neighbor.hexOrigin.x * 0.25,
      z: neighbor.hexOrigin.y * 0.25,
    }, 6), {
      regionId: neighbor.id,
      direction: expectedDirection,
    });
  }
});

test("region prefetch no longer uses physical same-row adjacency as a topology fallback", () => {
  assert.equal(resolveRegionPrefetch(extendedLayout, "garden-2", { x: 5.2, z: 0 }, 6), null);
  assert.deepEqual(resolveRegionPrefetch(extendedLayout, "garden-2", { x: -5.2, z: 0 }, 6), {
    regionId: "garden-3",
    direction: "west",
  });
});

test("region prefetch leaves missing hex neighbors cold", () => {
  assert.deepEqual(resolveRegionPrefetch(layout, "garden-1", { x: hexWidth / 8, z: -4.5 }, 6), {
    regionId: "garden-3",
    direction: "northEast",
  });
  assert.equal(resolveRegionPrefetch(layout, "garden-1", { x: -hexWidth / 8, z: -4.5 }, 6), null);
  assert.equal(resolveRegionPrefetch(layout, "garden-1", { x: hexWidth / 8, z: 4.5 }, 6), null);
  assert.equal(resolveRegionPrefetch(layout, "garden-3", { x: 5.2, z: 0 }, 6), null);
});
