import assert from "node:assert/strict";
import test from "node:test";
import {
  HEX_DIRECTIONS,
  axialRegionId,
  axialRegionNeighborId,
  hexDistance,
  hexNeighborCoordinate,
  parseAxialRegionId,
  projectHexCoordinate,
  projectPhysicalRegionOrigin,
  configuredRegionNeighborId,
  regionAxialCoordinate,
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

test("axial region ids round-trip signed coordinates in a canonical routing-safe form", () => {
  const samples = [
    { q: 0, r: 0 },
    { q: -12, r: 34 },
    { q: Number.MAX_SAFE_INTEGER, r: Number.MIN_SAFE_INTEGER },
  ];
  for (const coordinate of samples) {
    const regionId = axialRegionId(coordinate);
    assert.match(regionId, /^[a-z0-9-]+$/);
    assert.ok(regionId.length <= 48);
    assert.deepEqual(parseAxialRegionId(regionId), coordinate);
  }

  assert.equal(axialRegionId({ q: -12, r: 34 }), "hex-q-12-r34");
  assert.equal(parseAxialRegionId("garden-1"), undefined);
  assert.equal(parseAxialRegionId("hex-q01-r0"), undefined);
  assert.equal(parseAxialRegionId("hex-q9007199254740992-r0"), undefined);
  assert.throws(() => axialRegionId({ q: 0.5, r: 0 }), RangeError);
});

test("legacy garden aliases resolve to stable axial identities without depending on list position", () => {
  assert.deepEqual(regionAxialCoordinate("garden-1"), { q: 0, r: 0 });
  assert.deepEqual(regionAxialCoordinate("garden-2"), { q: 1, r: 0 });
  assert.deepEqual(regionAxialCoordinate("garden-3"), { q: 1, r: -1 });
  assert.deepEqual(regionAxialCoordinate("hex-q-2-r3"), { q: -2, r: 3 });
  assert.equal(regionAxialCoordinate("garden-4"), undefined);

  const sparse = regionHexTopology(["garden-1", "garden-3"]);
  assert.deepEqual(sparse.map(({ id, axial }) => ({ id, axial })), [
    { id: "garden-1", axial: { q: 0, r: 0 } },
    { id: "garden-3", axial: { q: 1, r: -1 } },
  ]);
  assert.equal(sparse[0].neighbors.east, null);
  assert.equal(sparse[0].neighbors.northEast, "garden-3");

  assert.equal(axialRegionNeighborId("garden-1", "east"), "garden-2");
  assert.equal(axialRegionNeighborId("garden-1", "northEast"), "garden-3");
  assert.equal(axialRegionNeighborId("garden-1", "northWest"), "hex-q0-r-1");
});

test("canonical topology preserves encoded coordinates even when configuration order is unrelated", () => {
  const topology = regionHexTopology(["hex-q10-r-4", "hex-q100-r100", "hex-q11-r-4"]);
  assert.deepEqual(topology.map(({ id, axial }) => ({ id, axial })), [
    { id: "hex-q10-r-4", axial: { q: 10, r: -4 } },
    { id: "hex-q100-r100", axial: { q: 100, r: 100 } },
    { id: "hex-q11-r-4", axial: { q: 11, r: -4 } },
  ]);
  assert.equal(topology[0].neighbors.east, "hex-q11-r-4");
  assert.equal(topology[0].neighbors.northEast, null);
});

test("dynamic axial ids resolve all six neighbors without a global region list", () => {
  const expected = [
    { q: 1, r: 0 },
    { q: 1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 },
  ];

  assert.deepEqual(
    HEX_DIRECTIONS.map((direction) => hexNeighborCoordinate({ q: 0, r: 0 }, direction)),
    expected,
  );
  assert.deepEqual(
    HEX_DIRECTIONS.map((direction) => axialRegionNeighborId("hex-q0-r0", direction)),
    expected.map((coordinate) => axialRegionId(coordinate)),
  );
  assert.throws(
    () => hexNeighborCoordinate({ q: Number.MAX_SAFE_INTEGER, r: 0 }, "east"),
    RangeError,
  );
});

test("configured region neighbor lookup uses axial identity without rebuilding full topology", () => {
  assert.equal(
    configuredRegionNeighborId(["garden-1", "garden-2", "garden-3", "hex-q0-r-1"], "garden-1", "northWest"),
    "hex-q0-r-1",
  );
  assert.equal(
    configuredRegionNeighborId(["hex-q0-r0", "garden-2"], "hex-q0-r0", "east"),
    "garden-2",
    "configured legacy aliases remain valid targets for canonical sources",
  );
  assert.equal(
    configuredRegionNeighborId(["garden-1", "garden-2", "garden-3"], "garden-1", "northWest"),
    undefined,
    "unconfigured dynamic neighbors remain disabled during the compatibility phase",
  );
  assert.equal(
    configuredRegionNeighborId(["region-a", "region-b"], "region-a", "east"),
    "region-b",
    "unknown historical ids retain the legacy ring fallback",
  );
});
