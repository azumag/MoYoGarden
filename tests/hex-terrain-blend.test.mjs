import assert from "node:assert/strict";
import test from "node:test";
import { regularHexFootprintSize } from "../public/client/hex-footprint.js";
import {
  blendBoundaryHeight,
  distanceOutsideHexFootprint,
  nearestHeightSample,
} from "../public/client/hex-terrain-blend.js";
import { hexCellRadius } from "../public/client/hex-grid.js";

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test("hex terrain stitching measures distance from the real macro-hex side", () => {
  const width = 40;
  const height = 24;
  const footprint = regularHexFootprintSize(width, height);
  close(distanceOutsideHexFootprint(0, 0, width, height), 0);
  close(distanceOutsideHexFootprint(footprint.width / 2 + 0.5, 0, width, height), 0.5);
  close(distanceOutsideHexFootprint(0, -footprint.height / 2 - 0.75, width, height), 0.75);
});

test("first neighbor-cell row locks to the center height and eases back to native terrain", () => {
  const radius = hexCellRadius(40, 24);
  const native = 0.8;
  const center = 0.2;

  close(blendBoundaryHeight(native, center, radius, radius, 2), center);
  const middle = blendBoundaryHeight(native, center, radius * 2, radius, 2);
  assert.ok(middle > center && middle < native);
  close(blendBoundaryHeight(native, center, radius * 4, radius, 2), native);
});

test("nearest center sample respects the seam search radius", () => {
  const samples = [
    { x: 0, z: 0, height: 0.2 },
    { x: 4, z: 0, height: 0.8 },
  ];
  const nearest = nearestHeightSample(0.5, 0, samples, 2);
  assert.ok(nearest);
  assert.equal(nearest.height, 0.2);
  close(nearest.distance, 0.5);
  assert.equal(nearestHeightSample(10, 0, samples, 1), undefined);
});
