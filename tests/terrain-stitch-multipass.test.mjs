import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  hexCellRadius,
  hexTileWorldXZ,
  isHexGridCell,
} from "../public/client/hex-grid.js";
import { regularHexFootprintSize } from "../public/client/hex-footprint.js";
import { stitchHexNeighborTerrain } from "../public/client/hex-terrain-stitching.js";
import {
  buildWeldedHexSurface,
  terrainVertexKey,
} from "../public/client/terrain-stitch.js";

function projectedRegionOrigin(axial, width, height) {
  const footprint = regularHexFootprintSize(width, height);
  return {
    x: (axial.q + axial.r * 0.5) * footprint.width,
    z: axial.r * footprint.height * 0.75,
  };
}

function buildTerrainMesh(width, height, surfaceHeight, name) {
  const entries = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tile = { x, y };
      if (!isHexGridCell(tile, width, height)) continue;
      const position = hexTileWorldXZ(tile, width, height);
      entries.push({
        x: position.x,
        z: position.z,
        height: surfaceHeight,
        color: { r: 0.4, g: 0.5, b: 0.3 },
      });
    }
  }

  const surface = buildWeldedHexSurface(
    entries,
    hexCellRadius(width, height),
    { footprintWidth: width, footprintHeight: height },
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(surface.positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(surface.colors, 3));
  geometry.setIndex(surface.indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true }));
  mesh.name = name;
  mesh.userData.moyoWeldedHexSurface = true;
  return mesh;
}
function worldVertexHeights(group) {
  const mesh = group.children[0];
  const position = mesh.geometry.getAttribute("position");
  const heights = new Map();
  for (let index = 0; index < position.count; index += 1) {
    heights.set(
      terrainVertexKey(
        group.position.x + position.getX(index),
        group.position.z + position.getZ(index),
      ),
      position.getY(index),
    );
  }
  return heights;
}

function sharedHeightPairs(left, right) {
  const a = worldVertexHeights(left);
  const b = worldVertexHeights(right);
  const shared = [];
  for (const [key, height] of a) {
    if (b.has(key)) shared.push([height, b.get(key)]);
  }
  return shared;
}

test("preview multi-pass stitching preserves an earlier adjacent seam", () => {
  const width = 40;
  const height = 24;
  const preview = new THREE.Group();
  preview.name = "neighbor-region-preview";
  preview.userData.moyoHexCells = true;

  const definitions = [
    ["garden-2", { q: 1, r: 0 }, 0.25],
    ["garden-3", { q: 1, r: -1 }, 0.35],
    ["hex-q-1-r0", { q: -1, r: 0 }, 0.45],
    ["hex-q-1-r1", { q: -1, r: 1 }, 0.1],
    ["hex-q0-r-1", { q: 0, r: -1 }, 0.6],
    ["hex-q0-r1", { q: 0, r: 1 }, 0.8],
  ];
  const groups = new Map();
  for (const [regionId, axial, surfaceHeight] of definitions) {
    const group = new THREE.Group();
    const origin = projectedRegionOrigin(axial, width, height);
    group.position.set(origin.x, 0, origin.z);
    group.userData.moyoRegionId = regionId;
    group.userData.moyoAxial = axial;
    group.add(buildTerrainMesh(width, height, surfaceHeight, "neighbor-hex-land"));
    preview.add(group);
    groups.set(regionId, group);
  }

  const worldRoot = new THREE.Group();
  worldRoot.add(preview);
  const view = {
    worldRoot,
    state: { regionId: "garden-1", revision: 1, width, height },
    terrainMesh: buildTerrainMesh(width, height, 0.5, "hex-cell-terrain"),
    waterMesh: null,
  };

  assert.equal(stitchHexNeighborTerrain(view), true);
  const shared = sharedHeightPairs(
    groups.get("garden-2"),
    groups.get("hex-q0-r1"),
  );
  assert.ok(shared.length > 0, "expected a shared garden-2 / southeast preview boundary");
  for (const [leftHeight, rightHeight] of shared) {
    assert.ok(
      Math.abs(leftHeight - rightHeight) <= 1e-6,
      `shared seam height diverged: ${leftHeight} != ${rightHeight}`,
    );
  }
});
