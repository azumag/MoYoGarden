import assert from "node:assert/strict";
import test from "node:test";

import {
  hexGridCenter,
  hexGridDistance,
  hexGridRadius,
  isHexGridCell,
} from "../dist-ts/src/hex-grid.js";

function referenceMembership(extent, position) {
  if (
    !Number.isInteger(position.x)
    || !Number.isInteger(position.y)
    || position.x < 0
    || position.y < 0
    || position.x >= extent.width
    || position.y >= extent.height
  ) return false;
  return hexGridDistance(position, hexGridCenter(extent)) <= hexGridRadius(extent);
}

test("inline hex membership preserves the existing footprint for representative extents", () => {
  for (const extent of [
    { width: 40, height: 24 },
    { width: 16, height: 12 },
    { width: 17, height: 13 },
    { width: 7, height: 7 },
    { width: 2, height: 2 },
    { width: 1, height: 1 },
  ]) {
    for (let y = -2; y <= extent.height + 1; y += 1) {
      for (let x = -2; x <= extent.width + 1; x += 1) {
        const position = { x, y };
        assert.equal(
          isHexGridCell(extent, position),
          referenceMembership(extent, position),
          `${extent.width}x${extent.height} membership mismatch at ${x},${y}`,
        );
      }
    }
  }
});

test("inline hex membership keeps non-integer coordinates outside the simulation grid", () => {
  const extent = { width: 40, height: 24 };
  for (const position of [
    { x: 19.5, y: 11 },
    { x: 19, y: 11.5 },
    { x: Number.NaN, y: 11 },
    { x: 19, y: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(isHexGridCell(extent, position), false);
  }
});
