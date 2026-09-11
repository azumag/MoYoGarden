import assert from "node:assert/strict";
import test from "node:test";
import { buildDynamicHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { hexGridBoundaryCells } from "../dist-ts/src/hex-grid.js";
import { pathogenHaloLinksForAgents } from "../dist-ts/src/pathogen-region.js";

function agent(id, position) {
  return { id, position: { ...position } };
}

test("pathogen halo fetch scope follows occupied boundary cells instead of all six seams", () => {
  const extent = { width: 40, height: 24 };
  const allLinks = buildDynamicHexHaloLinks(extent, "garden-1");
  const eastBoundary = hexGridBoundaryCells(extent, "east");
  const occupiedBoundary = eastBoundary[Math.floor(eastBoundary.length / 2)];
  assert.ok(occupiedBoundary);
  assert.ok(allLinks.length > 0);

  const filtered = pathogenHaloLinksForAgents({
    agents: [
      agent("edge", occupiedBoundary),
      agent("interior", { x: 19, y: 11 }),
    ],
  }, allLinks);

  assert.ok(filtered.length > 0, "the occupied seam must still materialize pathogen links");
  assert.ok(filtered.length < allLinks.length, "empty seams must not wake unrelated neighbor DOs");
  assert.ok(filtered.every((link) =>
    link.sourcePosition.x === occupiedBoundary.x &&
    link.sourcePosition.y === occupiedBoundary.y
  ));

  const allNeighbors = new Set(allLinks.map((link) => link.neighborRegionId));
  const requestedNeighbors = new Set(filtered.map((link) => link.neighborRegionId));
  assert.ok(
    requestedNeighbors.size < allNeighbors.size,
    "a single occupied boundary cell should request fewer neighbors than the full six-direction halo",
  );

  assert.deepEqual(
    pathogenHaloLinksForAgents({ agents: [agent("interior", { x: 19, y: 11 })] }, allLinks),
    [],
    "interior-only populations must not produce cross-DO pathogen reads",
  );
});
