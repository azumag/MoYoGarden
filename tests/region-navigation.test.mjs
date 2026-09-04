import test from "node:test";
import assert from "node:assert/strict";
import { resolveRegionRebase } from "../public/client/region-navigation.js";

const layout = [
  { id: "garden-1", origin: { x: 0, y: 0 }, extent: { width: 40, height: 24 } },
  { id: "garden-2", origin: { x: 40, y: 0 }, extent: { width: 40, height: 24 } },
  { id: "garden-3", origin: { x: 80, y: 0 }, extent: { width: 40, height: 24 } },
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
