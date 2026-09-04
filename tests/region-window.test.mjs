import assert from "node:assert/strict";
import test from "node:test";
import { enrichRegionWindowPayload } from "../dist-ts/src/worker-entry.js";

test("region window exposes both physical and hex placement metadata", () => {
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
    { x: 40, y: 0 },
    { x: 20, y: -18 },
  ]);
  assert.deepEqual(payload.chunks.map((chunk) => chunk.axial), [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
    { q: 1, r: -1 },
  ]);
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
