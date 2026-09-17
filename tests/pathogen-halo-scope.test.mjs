import assert from "node:assert/strict";
import test from "node:test";
import { buildDynamicHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { hexGridBoundaryCells } from "../dist-ts/src/hex-grid.js";
import {
  pathogenHaloEdgeRequests,
  pathogenHaloLinksForAgents,
  shouldMaterializePathogenHalo,
} from "../dist-ts/src/pathogen-region.js";

function agent(id, position, hp = 100) {
  return { id, position: { ...position }, hp };
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

test("dead boundary agents do not keep pathogen halo neighbors awake", () => {
  const extent = { width: 40, height: 24 };
  const allLinks = buildDynamicHexHaloLinks(extent, "garden-1");
  const boundary = hexGridBoundaryCells(extent, "east")[5];
  assert.ok(boundary);

  const deadOnly = { ...extent, agents: [agent("corpse", boundary, 0)] };
  assert.deepEqual(
    pathogenHaloLinksForAgents(deadOnly, allLinks),
    [],
    "a corpse-only seam must not issue pathogen edge reads",
  );
  assert.equal(
    shouldMaterializePathogenHalo(deadOnly, 29, 30),
    false,
    "halo cadence should stay local when only dead agents occupy the boundary",
  );

  const mixed = {
    ...extent,
    agents: [agent("corpse", boundary, 0), agent("living", boundary, 100)],
  };
  assert.ok(
    pathogenHaloLinksForAgents(mixed, allLinks).length > 0,
    "a living boundary agent must still materialize the exact seam",
  );
  assert.equal(
    shouldMaterializePathogenHalo(mixed, 29, 30),
    true,
    "a living boundary agent must still enable halo exposure on cadence",
  );
});

test("pathogen edge requests contain only the exact ghost cells paired to occupied seams", () => {
  const extent = { width: 40, height: 24 };
  const allLinks = buildDynamicHexHaloLinks(extent, "garden-1");
  const boundary = hexGridBoundaryCells(extent, "east")[5];
  assert.ok(boundary);

  const filtered = pathogenHaloLinksForAgents({ agents: [agent("edge", boundary)] }, allLinks);
  assert.ok(filtered.length > 0);

  const requests = pathogenHaloEdgeRequests(filtered);
  const requestedCells = new Set(requests.flatMap((request) =>
    request.positions.map((position) =>
      `${request.regionId}:${request.direction}:${position.x},${position.y}`
    )
  ));
  const expectedCells = new Set(filtered.map((link) =>
    `${link.neighborRegionId}:${link.neighborDirection}:${link.neighborPosition.x},${link.neighborPosition.y}`
  ));
  assert.deepEqual(requestedCells, expectedCells, "edge reads must not request unrelated boundary cells");

  const duplicated = pathogenHaloEdgeRequests([filtered[0], filtered[0]]);
  assert.equal(duplicated.length, 1, "duplicate links for one edge should share a request");
  assert.equal(duplicated[0].positions.length, 1, "the same ghost cell should be requested only once");
});
