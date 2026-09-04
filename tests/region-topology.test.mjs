import assert from "node:assert/strict";
import test from "node:test";
import {
  HEX_DIRECTIONS,
  hexDistance,
  projectHexCoordinate,
  regionHexTopology,
} from "../dist-ts/src/region-topology.js";

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

test("hex topology projects the first ring into two-dimensional global coordinates", () => {
  const topology = regionHexTopology([
    "garden-c",
    "garden-e",
    "garden-ne",
    "garden-nw",
    "garden-w",
    "garden-sw",
    "garden-se",
  ], 40, 24);

  assert.deepEqual(topology.map((entry) => entry.hexOrigin), [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 20, y: -18 },
    { x: -20, y: -18 },
    { x: -40, y: 0 },
    { x: -20, y: 18 },
    { x: 20, y: 18 },
  ]);
});

test("hex projection preserves east-west spacing while allowing custom region extents", () => {
  assert.deepEqual(projectHexCoordinate({ q: 1, r: 0 }, 64, 32), { x: 64, y: 0 });
  assert.deepEqual(projectHexCoordinate({ q: 1, r: -1 }, 64, 32), { x: 32, y: -24 });
  assert.deepEqual(projectHexCoordinate({ q: 0, r: 1 }, 64, 32), { x: 32, y: 24 });
});

test("hex topology fills complete rings before adding farther regions", () => {
  const topology = regionHexTopology(Array.from({ length: 19 }, (_, index) => `region-${index + 1}`));
  assert.deepEqual(
    [0, 1, 2].map((ring) => topology.filter((entry) => entry.ring === ring).length),
    [1, 6, 12],
  );
  assert.equal(hexDistance({ q: 2, r: -1 }), 2);
});
