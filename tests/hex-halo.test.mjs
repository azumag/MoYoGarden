import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildHexHaloLinks,
  hexHaloKey,
  hexHaloLookup,
  materializeHexHalo,
} from "../dist-ts/src/hex-halo.js";
import {
  HEX_GRID_DIRECTIONS,
  hexGridBoundaryCells,
  oppositeHexGridDirection,
} from "../dist-ts/src/hex-grid.js";

const extent = { width: 40, height: 24 };
const regionIds = Array.from({ length: 7 }, (_, index) => `garden-${index + 1}`);
const hexHaloSource = await readFile(new URL("../src/hex-halo.ts", import.meta.url), "utf8");
const haloRegionSource = await readFile(new URL("../src/halo-region.ts", import.meta.url), "utf8");

test("halo hot paths resolve only a bounded axial window", () => {
  assert.match(hexHaloSource, /regionHexWindow/);
  assert.doesNotMatch(hexHaloSource, /regionHexTopology/);
  assert.match(haloRegionSource, /regionHexWindow/);
  assert.doesNotMatch(haloRegionSource, /regionHexTopology/);
});

test("full ring center exposes one ghost link for every cell on all six sides", () => {
  const links = buildHexHaloLinks(extent, regionIds, "garden-1");
  assert.equal(links.length, 6 * 23);
  assert.equal(new Set(links.map((entry) => hexHaloKey(entry.sourcePosition, entry.direction))).size, links.length);

  for (const direction of HEX_GRID_DIRECTIONS) {
    const side = links.filter((entry) => entry.direction === direction);
    assert.equal(side.length, hexGridBoundaryCells(extent, direction).length);
    assert.equal(side.length, 23);
    assert.equal(new Set(side.map((entry) => entry.neighborRegionId)).size, 1);
  }
});

test("materialized halo attaches neighbor boundary tiles to source-cell directional links", () => {
  const links = buildHexHaloLinks(extent, regionIds, "garden-1");
  const snapshots = [];
  for (const direction of HEX_GRID_DIRECTIONS) {
    const side = links.filter((entry) => entry.direction === direction);
    assert.ok(side.length > 0);
    const neighborRegionId = side[0].neighborRegionId;
    const neighborDirection = oppositeHexGridDirection(direction);
    snapshots.push({
      regionId: neighborRegionId,
      direction: neighborDirection,
      tick: 3,
      revision: 4,
      tiles: side.map((entry, index) => ({
        position: { ...entry.neighborPosition },
        tile: {
          x: entry.neighborPosition.x,
          y: entry.neighborPosition.y,
          terrain: index % 2 === 0 ? "plain" : "forest",
          elevation: index / 100,
        },
      })),
    });
  }

  const halo = materializeHexHalo(links, snapshots);
  assert.equal(halo.length, links.length);
  const lookup = hexHaloLookup(halo);
  for (const link of links) {
    const ghost = lookup.get(hexHaloKey(link.sourcePosition, link.direction));
    assert.ok(ghost);
    assert.equal(ghost.neighborRegionId, link.neighborRegionId);
    assert.deepEqual(ghost.neighborPosition, link.neighborPosition);
    assert.equal(ghost.tile.x, link.neighborPosition.x);
    assert.equal(ghost.tile.y, link.neighborPosition.y);
  }
});

test("missing neighbor edge data leaves only unavailable ghost links unmaterialized", () => {
  const links = buildHexHaloLinks(extent, regionIds, "garden-1");
  const eastLinks = links.filter((entry) => entry.direction === "east");
  const eastRegion = eastLinks[0].neighborRegionId;
  const halo = materializeHexHalo(links, [{
    regionId: eastRegion,
    direction: "west",
    tick: 1,
    revision: 1,
    tiles: eastLinks.map((entry) => ({
      position: { ...entry.neighborPosition },
      tile: {
        x: entry.neighborPosition.x,
        y: entry.neighborPosition.y,
        terrain: "plain",
        elevation: 0.4,
      },
    })),
  }]);
  assert.equal(halo.length, 23);
  assert.ok(halo.every((entry) => entry.direction === "east"));
});
