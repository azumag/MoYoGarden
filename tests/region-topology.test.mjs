import assert from "node:assert/strict";
import test from "node:test";
import {
  HEX_DIRECTIONS,
  hexDistance,
  projectHexCoordinate,
  projectPhysicalRegionOrigin,
  regionHexTopology,
  regularHexFootprintSize,
} from "../dist-ts/src/region-topology.js";

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

function originClose(actual, expected) {
  close(actual.x, expected.x);
  close(actual.y, expected.y);
}

test("hex region topology gives the first region six equal-distance neighbors", () => {
  const topology = regionHexTopology([
    "garden-1",
    "garden-2",
    "garden-3",
    "garden-4",
    "garden-5",
    "garden-6",
    "garden-7",
  ]);

  assert.deepEqual(topology.map((entry) => entry.axial), [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
    { q: 1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 },
  ]);
  assert.deepEqual(topology[0].neighbors, {
    east: "garden-2",
    northEast: "garden-3",
    northWest: "garden-4",
    west: "garden-5",
    southWest: "garden-6",
    southEast: "garden-7",
  });
  assert.deepEqual(topology.slice(1).map((entry) => entry.ring), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(HEX_DIRECTIONS, [
    "east",
    "northEast",
    "northWest",
    "west",
    "southWest",
    "southEast",
  ]);
});

test("hex topology keeps rectangular storage origins while display origins follow a regular hex lattice", () => {
  const topology = regionHexTopology([
    "garden-c",
    "garden-e",
    "garden-ne",
    "garden-nw",
    "garden-w",
    "garden-sw",
    "garden-se",
  ], 40, 24);
  const footprint = regularHexFootprintSize(40, 24);

  assert.deepEqual(topology.map((entry) => entry.physicalOrigin), [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 80, y: 0 },
    { x: 120, y: 0 },
    { x: 160, y: 0 },
    { x: 200, y: 0 },
    { x: 240, y: 0 },
  ]);
  const expected = [
    { x: 0, y: 0 },
    { x: footprint.width, y: 0 },
    { x: footprint.width / 2, y: -18 },
    { x: -footprint.width / 2, y: -18 },
    { x: -footprint.width, y: 0 },
    { x: -footprint.width / 2, y: 18 },
    { x: footprint.width / 2, y: 18 },
  ];
  topology.forEach((entry, index) => originClose(entry.hexOrigin, expected[index]));
});

test("physical projection remains storage-compatible while hex projection uses one regular radius", () => {
  assert.deepEqual(projectPhysicalRegionOrigin(2, 64), { x: 128, y: 0 });
  const footprint = regularHexFootprintSize(64, 32);
  originClose(projectHexCoordinate({ q: 1, r: 0 }, 64, 32), { x: footprint.width, y: 0 });
  originClose(projectHexCoordinate({ q: 1, r: -1 }, 64, 32), { x: footprint.width / 2, y: -24 });
  originClose(projectHexCoordinate({ q: 0, r: 1 }, 64, 32), { x: footprint.width / 2, y: 24 });
  close(footprint.width / footprint.height, Math.sqrt(3) / 2);
});

test("hex topology fills complete rings before adding farther regions", () => {
  const topology = regionHexTopology(Array.from({ length: 19 }, (_, index) => `region-${index + 1}`));
  assert.deepEqual(
    [0, 1, 2].map((ring) => topology.filter((entry) => entry.ring === ring).length),
    [1, 6, 12],
  );
  assert.equal(hexDistance({ q: 2, r: -1 }), 2);
});
