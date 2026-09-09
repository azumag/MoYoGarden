import assert from "node:assert/strict";
import test from "node:test";
import { materializeHexHalo } from "../dist-ts/src/hex-halo.js";

test("materialized halo stays detached from edge snapshots and link coordinates", () => {
  const link = {
    sourceRegionId: "garden-1",
    sourcePosition: { x: 30, y: 11 },
    direction: "east",
    neighborRegionId: "garden-2",
    neighborPosition: { x: 8, y: 11 },
    neighborDirection: "west",
  };
  const tile = {
    x: 8,
    y: 11,
    terrain: "forest",
    elevation: 0.42,
    flowTo: { x: 7, y: 11 },
    drainage: 0.61,
    erosionPressure: 0.2,
    resource: { kind: "wood", amount: 12, maxAmount: 20 },
  };
  const snapshot = {
    regionId: "garden-2",
    direction: "west",
    revision: 9,
    tick: 42,
    tiles: [{ position: { x: 8, y: 11 }, tile }],
  };

  const [ghost] = materializeHexHalo([link], [snapshot]);
  assert.ok(ghost);
  assert.notStrictEqual(ghost.sourcePosition, link.sourcePosition);
  assert.notStrictEqual(ghost.neighborPosition, link.neighborPosition);
  assert.notStrictEqual(ghost.tile, tile);
  assert.notStrictEqual(ghost.tile.flowTo, tile.flowTo);
  assert.notStrictEqual(ghost.tile.resource, tile.resource);

  ghost.sourcePosition.x = -1;
  ghost.neighborPosition.y = -1;
  ghost.tile.elevation = 0.99;
  ghost.tile.flowTo.x = -1;
  ghost.tile.resource.amount = 0;

  assert.deepEqual(link.sourcePosition, { x: 30, y: 11 });
  assert.deepEqual(link.neighborPosition, { x: 8, y: 11 });
  assert.equal(tile.elevation, 0.42);
  assert.deepEqual(tile.flowTo, { x: 7, y: 11 });
  assert.deepEqual(tile.resource, { kind: "wood", amount: 12, maxAmount: 20 });

  link.sourcePosition.y = 99;
  tile.flowTo.y = 99;
  tile.resource.maxAmount = 99;

  assert.deepEqual(ghost.sourcePosition, { x: -1, y: 11 });
  assert.deepEqual(ghost.tile.flowTo, { x: -1, y: 11 });
  assert.deepEqual(ghost.tile.resource, { kind: "wood", amount: 0, maxAmount: 20 });
});
