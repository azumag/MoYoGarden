import assert from "node:assert/strict";
import test from "node:test";
import { buildConfiguredHexHaloLinks, buildDynamicHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { HEX_GRID_DIRECTION_STEPS, hexGridBoundaryCells, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { regionGlobalCellOrigin } from "../dist-ts/src/region-topology.js";

const extent = { width: 40, height: 24 };

test("configured halo reads the exact adjacent global cells", () => {
  const links = buildConfiguredHexHaloLinks(extent, ["garden-1", "garden-2", "garden-3"], "garden-1");
  assert.equal(links.length, 46, "must keep the existing configured-only fan-out");
  const sourceOrigin = regionGlobalCellOrigin("garden-1", extent.width, extent.height);
  assert.ok(sourceOrigin);
  for (const link of links) {
    const step = HEX_GRID_DIRECTION_STEPS[link.direction];
    const targetOrigin = regionGlobalCellOrigin(link.neighborRegionId, extent.width, extent.height);
    assert.ok(targetOrigin);
    assert.equal(isHexGridCell(extent, link.neighborPosition), true);
    assert.equal(hexGridBoundaryCells(extent, link.neighborDirection).some((position) => position.x === link.neighborPosition.x && position.y === link.neighborPosition.y), true);
    assert.deepEqual(
      { x: targetOrigin.x + link.neighborPosition.x, y: targetOrigin.y + link.neighborPosition.y },
      { x: sourceOrigin.x + link.sourcePosition.x + step.x, y: sourceOrigin.y + link.sourcePosition.y + step.y },
      `${link.sourcePosition.x},${link.sourcePosition.y} ${link.direction}`,
    );
  }
});

test("historical configured ids do not downgrade migrated halo neighbors", () => {
  const knownIds = ["garden-1", "garden-2", "garden-3"];
  const exactKnown = buildConfiguredHexHaloLinks(extent, knownIds, "garden-1");
  const mixed = buildConfiguredHexHaloLinks(
    extent,
    [...knownIds, "historical-garden-4"],
    "garden-1",
  );

  assert.deepEqual(
    mixed.filter((link) => link.neighborRegionId !== "historical-garden-4"),
    exactKnown,
    "known axial neighbors must keep exact global-cell ownership",
  );
  assert.ok(
    mixed.some((link) => link.neighborRegionId === "historical-garden-4"),
    "the unresolved historical neighbor must retain a compatibility halo",
  );
  const keys = mixed.map((link) => `${link.sourcePosition.x},${link.sourcePosition.y}:${link.direction}`);
  assert.equal(
    new Set(keys).size,
    keys.length,
    "historical fallback must never overwrite an exact source-direction slot",
  );
});

test("dynamic canonical halo covers all six exact global neighbors", () => {
  const sourceRegionId = "hex-q0-r1";
  const links = buildDynamicHexHaloLinks(extent, sourceRegionId);
  assert.equal(links.length, 138, "depth-1 halo must stay bounded to six 23-cell edges");
  assert.deepEqual(
    [...new Set(links.map((link) => link.neighborRegionId))].sort(),
    ["garden-1", "garden-2", "hex-q-1-r1", "hex-q-1-r2", "hex-q0-r2", "hex-q1-r1"].sort(),
  );
  const sourceOrigin = regionGlobalCellOrigin(sourceRegionId, extent.width, extent.height);
  assert.ok(sourceOrigin);
  for (const link of links) {
    const step = HEX_GRID_DIRECTION_STEPS[link.direction];
    const targetOrigin = regionGlobalCellOrigin(link.neighborRegionId, extent.width, extent.height);
    assert.ok(targetOrigin);
    assert.equal(isHexGridCell(extent, link.neighborPosition), true);
    assert.equal(hexGridBoundaryCells(extent, link.neighborDirection).some((position) => position.x === link.neighborPosition.x && position.y === link.neighborPosition.y), true);
    assert.deepEqual(
      { x: targetOrigin.x + link.neighborPosition.x, y: targetOrigin.y + link.neighborPosition.y },
      { x: sourceOrigin.x + link.sourcePosition.x + step.x, y: sourceOrigin.y + link.sourcePosition.y + step.y },
    );
  }
});
