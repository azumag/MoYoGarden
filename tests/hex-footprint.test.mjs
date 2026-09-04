import assert from "node:assert/strict";
import test from "node:test";
import {
  hexFootprintHalfWidthAtZ,
  hexFootprintVertices,
  isPointInsideHexFootprint,
  isTileCenterInsideHexFootprint,
} from "../public/client/hex-footprint.js";

test("hex footprint matches the pointy-top region lattice used by hex origins", () => {
  assert.deepEqual(hexFootprintVertices(40, 24), [
    { x: 0, z: -12 },
    { x: 20, z: -6 },
    { x: 20, z: 6 },
    { x: 0, z: 12 },
    { x: -20, z: 6 },
    { x: -20, z: -6 },
  ]);
  assert.equal(hexFootprintHalfWidthAtZ(0, 40, 24), 20);
  assert.equal(hexFootprintHalfWidthAtZ(6, 40, 24), 20);
  assert.equal(hexFootprintHalfWidthAtZ(9, 40, 24), 10);
  assert.equal(hexFootprintHalfWidthAtZ(12, 40, 24), 0);
});

test("hex footprint removes rectangular corners without shrinking the middle", () => {
  assert.equal(isPointInsideHexFootprint(0, 0, 40, 24), true);
  assert.equal(isPointInsideHexFootprint(19.9, 0, 40, 24), true);
  assert.equal(isPointInsideHexFootprint(0, 11.9, 40, 24), true);
  assert.equal(isPointInsideHexFootprint(19, 11, 40, 24), false);
  assert.equal(isPointInsideHexFootprint(-19, -11, 40, 24), false);
  assert.equal(isPointInsideHexFootprint(20.1, 0, 40, 24), false);
});

test("40x24 tile centers form a symmetric discrete hex mask for preview reuse", () => {
  const visible = [];
  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < 40; x += 1) {
      if (isTileCenterInsideHexFootprint({ x, y }, 40, 24)) visible.push({ x, y });
    }
  }
  assert.equal(visible.length, 720);
  const rowCounts = Array.from({ length: 24 }, (_, y) => visible.filter((tile) => tile.y === y).length);
  assert.deepEqual(rowCounts, [4, 10, 16, 24, 30, 36, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 36, 30, 24, 16, 10, 4]);
});
