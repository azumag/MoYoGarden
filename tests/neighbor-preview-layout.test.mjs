import assert from "node:assert/strict";
import test from "node:test";
import * as previewLayout from "../public/client/neighbor-preview-layout.js";

const {
  buildNeighborPreviewPlacements,
  resolvePhysicalPreviewPlacement,
} = previewLayout;

const regularHexWidth = 12 * Math.sqrt(3);
const topology = [
  {
    id: "garden-1",
    axial: { q: 0, r: 0 },
    physicalOrigin: { x: 0, y: 0 },
    hexOrigin: { x: 0, y: 0 },
  },
  {
    id: "garden-2",
    axial: { q: 1, r: 0 },
    physicalOrigin: { x: 40, y: 0 },
    hexOrigin: { x: regularHexWidth, y: 0 },
  },
  {
    id: "garden-3",
    axial: { q: 1, r: -1 },
    physicalOrigin: { x: 80, y: 0 },
    hexOrigin: { x: regularHexWidth / 2, y: -18 },
  },
];

test("neighbor preview separates rectangular ownership from regular-hex display placement", () => {
  const placements = buildNeighborPreviewPlacements(topology, "garden-1");
  assert.deepEqual(placements.map(({ regionId, physicalOffset, hexOffset }) => ({
    regionId,
    physicalOffset,
    hexOffset,
  })), [
    {
      regionId: "garden-2",
      physicalOffset: { x: 40, z: 0 },
      hexOffset: { x: regularHexWidth, z: 0 },
    },
    {
      regionId: "garden-3",
      physicalOffset: { x: 80, z: 0 },
      hexOffset: { x: regularHexWidth / 2, z: -18 },
    },
  ]);
});

test("physical preview instances are assigned back to their source region before hex placement", () => {
  const placements = buildNeighborPreviewPlacements(topology, "garden-1");
  assert.equal(resolvePhysicalPreviewPlacement(placements, 20.5, -11.5, 40, 24)?.regionId, "garden-2");
  assert.equal(resolvePhysicalPreviewPlacement(placements, 59.5, 11.5, 40, 24)?.regionId, "garden-2");
  assert.equal(resolvePhysicalPreviewPlacement(placements, 60.5, -11.5, 40, 24)?.regionId, "garden-3");
  assert.equal(resolvePhysicalPreviewPlacement(placements, 99.5, 11.5, 40, 24)?.regionId, "garden-3");
});

test("garden-3 remains north-west of garden-2 after regularizing the hex geometry", () => {
  const placements = buildNeighborPreviewPlacements(topology, "garden-2");
  const garden3 = placements.find((entry) => entry.regionId === "garden-3");
  assert.deepEqual(garden3?.physicalOffset, { x: 40, z: 0 });
  assert.deepEqual(garden3?.hexOffset, { x: -regularHexWidth / 2, z: -18 });
});

test("loaded preview regions expose their neighbor-to-neighbor seam instead of only center seams", () => {
  const placements = buildNeighborPreviewPlacements(topology, "garden-1");
  const adjacentHexPreviewPairs = previewLayout.adjacentHexPreviewPairs;
  assert.equal(typeof adjacentHexPreviewPairs, "function");
  assert.deepEqual(
    adjacentHexPreviewPairs(placements).map(([source, target]) => [source.regionId, target.regionId]),
    [["garden-2", "garden-3"]],
  );
});
