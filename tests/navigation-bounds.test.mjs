import test from "node:test";
import assert from "node:assert/strict";
import { resolveNavigationBounds } from "../public/client/navigation-bounds.js";

test("navigation bounds expand into loaded neighboring chunks", () => {
  const state = { width: 40, height: 24 };
  assert.deepEqual(resolveNavigationBounds(state), {
    minX: -19.6,
    maxX: 19.6,
    minZ: -11.6,
    maxZ: 11.6,
  });

  const east = resolveNavigationBounds(state, {
    min: { x: 20, z: -12 },
    max: { x: 60, z: 12 },
  });
  assert.equal(east.minX, -19.6);
  assert.equal(east.maxX, 59.6);
  assert.equal(east.minZ, -11.6);
  assert.equal(east.maxZ, 11.6);

  const bothSides = resolveNavigationBounds(state, {
    min: { x: -60, z: -12 },
    max: { x: 60, z: 12 },
  });
  assert.equal(bothSides.minX, -59.6);
  assert.equal(bothSides.maxX, 59.6);
});

test("invalid preview bounds never shrink the local playable area", () => {
  const state = { width: 40, height: 24 };
  assert.deepEqual(
    resolveNavigationBounds(state, { min: { x: Number.NaN, z: 0 }, max: { x: 1, z: 1 } }),
    resolveNavigationBounds(state),
  );
});
