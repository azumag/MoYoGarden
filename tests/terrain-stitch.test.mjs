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

test("preview corners blend smoothly away from the center-region edge", () => {
  const tiles = new Map([
    [terrainVertexKey(20.5, 0.5), 0.4],
    [terrainVertexKey(20.5, 1.5), 0.6],
    [terrainVertexKey(21.5, 0.5), 0.8],
    [terrainVertexKey(21.5, 1.5), 1.0],
    [terrainVertexKey(22.5, 0.5), 0.2],
    [terrainVertexKey(22.5, 1.5), 0.4],
    [terrainVertexKey(23.5, 0.5), 0.6],
    [terrainVertexKey(23.5, 1.5), 0.8],
  ]);
  const boundary = new Map([[terrainVertexKey(20, 1), 0.73]]);

  assert.equal(resolvePreviewCornerHeight(20, 1, tiles, boundary), 0.73);

  const firstInterior = resolvePreviewCornerHeight(21, 1, tiles, boundary);
  assert.ok(Math.abs(firstInterior - 0.7222222222) < 1e-9);
  assert.ok(firstInterior > 0.7 && firstInterior < 0.73);

  assert.equal(resolvePreviewCornerHeight(23, 1, tiles, boundary), 0.5);
});

test("preview seam interpolates sparse boundary vertices instead of leaving zipper gaps", () => {
  const tiles = new Map([
    [terrainVertexKey(20.5, 0.5), 0.2],
    [terrainVertexKey(20.5, 1.5), 0.4],
    [terrainVertexKey(21.5, 0.5), 0.4],
    [terrainVertexKey(21.5, 1.5), 0.6],
  ]);
  const boundary = new Map([
    [terrainVertexKey(20, 0), 0.6],
    [terrainVertexKey(20, 2), 0.8],
  ]);

  assert.ok(Math.abs(resolvePreviewCornerHeight(20, 1, tiles, boundary) - 0.7) < 1e-9);
  const interior = resolvePreviewCornerHeight(21, 1, tiles, boundary);
  assert.ok(interior > 0.5 && interior < 0.7);
});

test("preview seam blending ignores boundary samples that do not bracket the corner", () => {
  const tiles = new Map([
    [terrainVertexKey(20.5, 0.5), 0.4],
    [terrainVertexKey(20.5, 1.5), 0.6],
    [terrainVertexKey(21.5, 0.5), 0.8],
    [terrainVertexKey(21.5, 1.5), 1.0],
  ]);
  const unrelatedBoundary = new Map([[terrainVertexKey(20, 5), 0.95]]);

  assert.equal(resolvePreviewCornerHeight(21, 1, tiles, unrelatedBoundary), 0.7);
});
