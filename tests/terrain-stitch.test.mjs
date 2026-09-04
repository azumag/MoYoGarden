import assert from "node:assert/strict";
import test from "node:test";
import {
  collectBoundaryHeights,
  resolvePreviewCornerHeight,
  terrainVertexKey,
} from "../public/client/terrain-stitch.js";

test("boundary height collection keeps the visible top edge", () => {
  const positions = new Float32Array([
    20, 0.42, -1,
    20, 0.55, -1,
    19, 0.9, -1,
    -20, 0.31, 2,
    0, 0.25, 12,
  ]);
  const heights = collectBoundaryHeights(positions, 20, 12);
  assert.ok(Math.abs(heights.get(terrainVertexKey(20, -1)) - 0.55) < 1e-6);
  assert.ok(Math.abs(heights.get(terrainVertexKey(-20, 2)) - 0.31) < 1e-6);
  assert.equal(heights.get(terrainVertexKey(0, 12)), 0.25);
  assert.equal(heights.has(terrainVertexKey(19, -1)), false);
});

test("preview corners prefer the center-region edge and otherwise average adjacent tiles", () => {
  const tiles = new Map([
    [terrainVertexKey(20.5, 0.5), 0.4],
    [terrainVertexKey(20.5, 1.5), 0.6],
    [terrainVertexKey(21.5, 0.5), 0.8],
    [terrainVertexKey(21.5, 1.5), 1.0],
  ]);
  const boundary = new Map([[terrainVertexKey(20, 1), 0.73]]);

  assert.equal(resolvePreviewCornerHeight(20, 1, tiles, boundary), 0.73);
  assert.equal(resolvePreviewCornerHeight(21, 1, tiles, boundary), 0.7);
});
