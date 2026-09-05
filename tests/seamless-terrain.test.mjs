import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as terrainStitch from "../public/client/terrain-stitch.js";

const hexTileRenderingSource = await readFile(
  new URL("../public/client/hex-tile-rendering.js", import.meta.url),
  "utf8",
);
const hexTerrainStitchingSource = await readFile(
  new URL("../public/client/hex-terrain-stitching.js", import.meta.url),
  "utf8",
);

function vertexAt(surface, x, z, epsilon = 1e-5) {
  for (let index = 0; index + 2 < surface.positions.length; index += 3) {
    if (
      Math.abs(surface.positions[index] - x) <= epsilon
      && Math.abs(surface.positions[index + 2] - z) <= epsilon
    ) {
      return {
        y: surface.positions[index + 1],
        color: surface.colors.slice(index, index + 3),
      };
    }
  }
  return null;
}

test("adjacent hex cells weld their shared edge and average corner heights", () => {
  assert.equal(typeof terrainStitch.buildWeldedHexSurface, "function");
  const radius = 1;
  const root3 = Math.sqrt(3);
  const surface = terrainStitch.buildWeldedHexSurface([
    { x: 0, z: 0, height: 0.2, color: { r: 1, g: 0, b: 0 } },
    { x: 1.5, z: root3 / 2, height: 0.8, color: { r: 0, g: 0, b: 1 } },
  ], radius);

  assert.equal(surface.vertexCount, 12, "two neighboring hexes should share their two edge vertices");
  assert.equal(surface.indices.length, 36);

  const upperShared = vertexAt(surface, 0.5, root3 / 2);
  const lowerShared = vertexAt(surface, 1, 0);
  assert.ok(upperShared && lowerShared);
  assert.ok(Math.abs(upperShared.y - 0.5) < 1e-9);
  assert.ok(Math.abs(lowerShared.y - 0.5) < 1e-9);
  assert.deepEqual(upperShared.color, [0.5, 0, 0.5]);
  assert.deepEqual(lowerShared.color, [0.5, 0, 0.5]);
});

test("hex terrain uses the full geometric radius without visible cell gutters", () => {
  assert.doesNotMatch(hexTileRenderingSource, /hexCellRadius\([^\n]+\)\s*\*\s*0\.985/);
  assert.match(hexTileRenderingSource, /buildWeldedHexSurface/);
  assert.match(hexTileRenderingSource, /moyoWeldedHexSurface/);
});

test("neighbor terrain is converted to welded shared-vertex meshes instead of hex instances", () => {
  assert.match(hexTileRenderingSource, /buildWeldedNeighborSurface/);
  assert.match(hexTileRenderingSource, /new THREE\.Mesh\(/);
  assert.doesNotMatch(hexTileRenderingSource, /new THREE\.InstancedMesh\(converted\.geometry/);
});

test("region seam stitching locks shared vertices and recomputes smooth normals", () => {
  assert.match(hexTerrainStitchingSource, /terrainVertexKey/);
  assert.match(hexTerrainStitchingSource, /geometry\.getAttribute\("position"\)/);
  assert.match(hexTerrainStitchingSource, /centerVertexHeights/);
  assert.match(hexTerrainStitchingSource, /computeVertexNormals\(\)/);
  assert.doesNotMatch(hexTerrainStitchingSource, /mesh\.instanceMatrix\.needsUpdate/);
});
