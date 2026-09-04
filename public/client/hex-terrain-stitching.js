import * as THREE from "three";
import { hexCellRadius, hexTileWorldXZ, isHexGridCell } from "./hex-grid.js";
import {
  blendBoundaryHeight,
  distanceOutsideHexFootprint,
  nearestHeightSample,
} from "./hex-terrain-blend.js";
import { WorldView } from "./world-view.js";

const BLEND_ROWS = 2.25;
const SAMPLE_SEARCH_RADII = 3.4;

function centerHeightSamples(view) {
  const width = Number(view.state?.width);
  const height = Number(view.state?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return { land: [], water: [] };

  const land = [];
  const water = [];
  for (const tile of view.state?.tiles ?? []) {
    if (!isHexGridCell(tile, width, height)) continue;
    const position = hexTileWorldXZ(tile, width, height);
    const stored = view.surfaceHeightMap?.get(`${tile.x}:${tile.y}`);
    if (!Number.isFinite(stored)) continue;
    const sample = {
      x: position.x,
      z: position.z,
      height: stored + (tile.terrain === "water" ? 0.04 : 0),
    };
    if (tile.terrain === "water") water.push(sample);
    else land.push(sample);
  }
  return { land, water };
}

function nativeYValues(mesh, matrix) {
  const cached = mesh.userData?.moyoHexTerrainNativeY;
  if (Array.isArray(cached) && cached.length === mesh.count) return cached;
  const values = [];
  for (let index = 0; index < mesh.count; index += 1) {
    mesh.getMatrixAt(index, matrix);
    values.push(matrix.elements[13]);
  }
  mesh.userData.moyoHexTerrainNativeY = values;
  return values;
}

function stitchMesh(mesh, group, samples, width, height, cellRadius, matrix) {
  if (!mesh?.isInstancedMesh || mesh.count <= 0 || samples.length === 0) return false;
  const isLand = mesh.name === "neighbor-hex-land";
  const isWater = mesh.name === "neighbor-hex-water";
  if (!isLand && !isWater) return false;

  const nativeY = nativeYValues(mesh, matrix);
  const topOffset = isLand
    ? (Number(mesh.geometry?.parameters?.height) || 0.08) * 0.5
    : 0;
  const maximumBoundaryDistance = cellRadius * (1.05 + BLEND_ROWS);
  const sampleDistance = cellRadius * SAMPLE_SEARCH_RADII;
  let changed = false;

  for (let index = 0; index < mesh.count; index += 1) {
    mesh.getMatrixAt(index, matrix);
    const originalY = nativeY[index];
    if (!Number.isFinite(originalY)) continue;

    const worldX = group.position.x + matrix.elements[12];
    const worldZ = group.position.z + matrix.elements[14];
    const boundaryDistance = distanceOutsideHexFootprint(worldX, worldZ, width, height);
    let nextY = originalY;

    if (boundaryDistance <= maximumBoundaryDistance) {
      const nearest = nearestHeightSample(worldX, worldZ, samples, sampleDistance);
      if (nearest !== undefined) {
        const nativeTop = originalY + topOffset;
        const blendedTop = blendBoundaryHeight(
          nativeTop,
          nearest.height,
          boundaryDistance,
          cellRadius,
          BLEND_ROWS,
        );
        nextY = blendedTop - topOffset;
      }
    }

    if (Math.abs(matrix.elements[13] - nextY) <= 1e-9) continue;
    matrix.elements[13] = nextY;
    mesh.setMatrixAt(index, matrix);
    changed = true;
  }

  if (changed) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere?.();
  }
  return changed;
}

export function stitchHexNeighborTerrain(view) {
  const preview = view.worldRoot?.getObjectByName("neighbor-region-preview");
  if (!preview?.userData?.moyoHexCells || !view.state) return false;

  const width = Number(view.state.width);
  const height = Number(view.state.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return false;
  }

  const revision = `${view.state.regionId}:${view.state.revision}:${preview.uuid}`;
  if (preview.userData.moyoHexTerrainStitchRevision === revision) return false;

  const samples = centerHeightSamples(view);
  const radius = hexCellRadius(width, height);
  const matrix = new THREE.Matrix4();
  let changed = false;

  for (const group of preview.children.filter((entry) => entry?.isGroup)) {
    for (const mesh of group.children) {
      const sourceSamples = mesh.name === "neighbor-hex-water" ? samples.water : samples.land;
      changed = stitchMesh(mesh, group, sourceSamples, width, height, radius, matrix) || changed;
    }
  }

  preview.userData.moyoHexTerrainStitchRevision = revision;
  if (changed) view.__moyoNavigationPreview = undefined;
  return changed;
}

const previousMarkShadowsDirty = WorldView.prototype.markShadowsDirty;
WorldView.prototype.markShadowsDirty = function markShadowsDirtyWithHexTerrainStitching() {
  previousMarkShadowsDirty.call(this);
  stitchHexNeighborTerrain(this);
};
