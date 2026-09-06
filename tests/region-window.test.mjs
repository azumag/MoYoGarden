import assert from "node:assert/strict";
import test from "node:test";
import { enrichRegionWindowPayload } from "../dist-ts/src/worker-entry.js";

const regularHexWidth = 12 * Math.sqrt(3);

test("region window exposes both physical and regular-hex placement metadata", () => {
  const payload = enrichRegionWindowPayload({
    coordinateSpace: "global-grid",
    centerRegion: "garden-1",
    radius: 1,
    chunks: [
      { regionId: "garden-1", origin: { x: 0, y: 0 } },
      { regionId: "garden-2", origin: { x: 40, y: 0 } },
      { regionId: "garden-3", origin: { x: 80, y: 0 } },
    ],
  }, ["garden-1", "garden-2", "garden-3"]);

  assert.equal(payload.layoutMode, "hex-migration");
  assert.deepEqual(payload.originSemantics, {
    origin: "physical",
    physicalOrigin: "persisted-rectangular-ownership",
    hexOrigin: "logical-hex-placement",
  });
  assert.deepEqual(payload.chunks.map((chunk) => chunk.origin), [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 80, y: 0 },
  ]);
  assert.deepEqual(payload.chunks.map((chunk) => chunk.physicalOrigin), [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 80, y: 0 },
  ]);
  assert.deepEqual(payload.chunks.map((chunk) => chunk.hexOrigin), [
    { x: 0, y: 0 },
    { x: regularHexWidth, y: 0 },
    { x: regularHexWidth / 2, y: -18 },
  ]);
  assert.deepEqual(payload.chunks.map((chunk) => chunk.axial), [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
    { q: 1, r: -1 },
  ]);
});

test("region window keeps the center snapshot complete while passive neighbors carry only active hex tiles", () => {
  const tiles = Array.from({ length: 40 * 24 }, (_, index) => ({
    x: index % 40,
    y: Math.floor(index / 40),
    terrain: "plain",
  }));
  const agents = [{ id: "neighbor-agent", position: { x: 19, y: 11 } }];
  const structures = [{ id: "neighbor-store", position: { x: 20, y: 11 } }];
  const state = { width: 40, height: 24, tiles, agents, structures };
  const payload = enrichRegionWindowPayload({
    centerRegion: "garden-1",
    chunks: [
      { regionId: "garden-1", state },
      { regionId: "garden-2", state },
    ],
  }, ["garden-1", "garden-2"]);

  assert.equal(payload.chunks[0].state.tiles.length, 960);
  assert.equal(payload.chunks[1].state.tiles.length, 397);
  assert.ok(payload.chunks[1].state.tiles.every((tile) => tile.x >= 8 && tile.x <= 30));
  assert.equal(payload.chunks[1].state.tiles.some((tile) => tile.x === 0 && tile.y === 0), false);
  assert.deepEqual(payload.chunks[1].state.agents, agents);
  assert.deepEqual(payload.chunks[1].state.structures, structures);
});

test("region window enrichment leaves unknown chunks intact", () => {
  const payload = enrichRegionWindowPayload({
    chunks: [{ regionId: "external", origin: { x: 99, y: 99 } }],
  }, ["garden-1"]);
  assert.deepEqual(payload.chunks[0], {
    regionId: "external",
    origin: { x: 99, y: 99 },
  });
});
