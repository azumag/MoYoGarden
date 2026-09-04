import assert from "node:assert/strict";
import test from "node:test";
import {
  hexFootprintHalfWidthAtZ,
  hexFootprintVertices,
  isPointInsideHexFootprint,
  isTileCenterInsideHexFootprint,
  regularHexFootprintSize,
} from "../public/client/hex-footprint.js";

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test("hex footprint is a regular pointy-top hex fitted inside the rectangular storage extent", () => {
  const size = regularHexFootprintSize(40, 24);
  close(size.radius, 12);
  close(size.width, 12 * Math.sqrt(3));
  close(size.height, 24);

  const vertices = hexFootprintVertices(40, 24);
  const expected = [
    { x: 0, z: -12 },
    { x: 6 * Math.sqrt(3), z: -6 },
    { x: 6 * Math.sqrt(3), z: 6 },
    { x: 0, z: 12 },
    { x: -6 * Math.sqrt(3), z: 6 },
    { x: -6 * Math.sqrt(3), z: -6 },
  ];
  vertices.forEach((vertex, index) => {
    close(vertex.x, expected[index].x);
    close(vertex.z, expected[index].z);
    close(distance(vertex, vertices[(index + 1) % vertices.length]), size.radius);
  });

  close(hexFootprintHalfWidthAtZ(0, 40, 24), 6 * Math.sqrt(3));
  close(hexFootprintHalfWidthAtZ(6, 40, 24), 6 * Math.sqrt(3));
  close(hexFootprintHalfWidthAtZ(9, 40, 24), 3 * Math.sqrt(3));
  close(hexFootprintHalfWidthAtZ(12, 40, 24), 0);
});

test("regular hex footprint removes the horizontal stretch and rectangular corners", () => {
  assert.equal(isPointInsideHexFootprint(0, 0, 40, 24), true);
  assert.equal(isPointInsideHexFootprint(10, 0, 40, 24), true);
  assert.equal(isPointInsideHexFootprint(11, 0, 40, 24), false);
  assert.equal(isPointInsideHexFootprint(0, 11.9, 40, 24), true);
  assert.equal(isPointInsideHexFootprint(10, 11, 40, 24), false);
  assert.equal(isPointInsideHexFootprint(-10, -11, 40, 24), false);
});

test("40x24 tile centers form a symmetric regular-hex mask for preview reuse", () => {
  const visible = [];
  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < 40; x += 1) {
      if (isTileCenterInsideHexFootprint({ x, y }, 40, 24)) visible.push({ x, y });
    }
  }
  assert.equal(visible.length, 368);
  const rowCounts = Array.from({ length: 24 }, (_, y) => visible.filter((tile) => tile.y === y).length);
  assert.deepEqual(rowCounts, [2, 6, 8, 12, 16, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 16, 12, 8, 6, 2]);
});
