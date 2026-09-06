import { hexCellRadius } from "./hex-grid.js";
import {
  blendBoundaryHeight,
  distanceOutsideHexFootprint,
  nearestHeightSample,
} from "./hex-terrain-blend.js";
import { terrainVertexKey } from "./terrain-stitch.js";
import { WorldView } from "./world-view.js";

const BLEND_ROWS = 2.25;
const SAMPLE_SEARCH_RADII = 3.4;

function centerVertexHeights(mesh) {
  const heights = new Map();
  const normals = new Map();
  const samplesByKey = new Map();
  const geometry = mesh?.geometry;
  const position = geometry?.getAttribute("position");
  const normal = geometry?.getAttribute("normal");
  if (!position) return { heights, normals, samples: [] };

  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    if (![x, y, z].every(Number.isFinite)) continue;
    const key = terrainVertexKey(x, z);
    const previous = samplesByKey.get(key);
    if (!previous || y > previous.height) {
      heights.set(key, y);
      samplesByKey.set(key, { x, z, height: y });
      if (normal) {
        normals.set(key, {
          x: normal.getX(index),
          y: normal.getY(index),
          z: normal.getZ(index),
        });
      }
    }
  }
  return { heights, normals, samples: [...samplesByKey.values()] };
}

function nativeYValues(mesh) {
  const geometry = mesh?.geometry;
  const position = geometry?.getAttribute("position");
  if (!position) return [];
  const cached = mesh.userData?.moyoHexTerrainNativeY;
  if (Array.isArray(cached) && cached.length === position.count) return cached;
  const values = Array.from({ length: position.count }, (_, index) => position.getY(index));
  mesh.userData.moyoHexTerrainNativeY = values;
  return values;
}

function copySharedNormals(mesh, group, centerSurface) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (!position || !normal || centerSurface.normals.size === 0) return false;

  let changed = false;
  for (let index = 0; index < position.count; index += 1) {
    const worldX = group.position.x + position.getX(index);
    const worldZ = group.position.z + position.getZ(index);
    const source = centerSurface.normals.get(terrainVertexKey(worldX, worldZ));
    if (!source) continue;
    normal.setXYZ(index, source.x, source.y, source.z);
    changed = true;
  }
  if (changed) normal.needsUpdate = true;
  return changed;
}

function stitchMesh(mesh, group, centerSurface, width, height, cellRadius) {
  if (!mesh?.isMesh || !mesh.userData?.moyoWeldedHexSurface) return false;
  const isLand = mesh.name === "neighbor-hex-land";
  const isWater = mesh.name === "neighbor-hex-water";
  if (!isLand && !isWater) return false;

  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  if (!position || position.count <= 0) return false;
  const nativeY = nativeYValues(mesh);
  if (nativeY.length !== position.count) return false;

  const maximumBoundaryDistance = cellRadius * (1.05 + BLEND_ROWS);
  const sampleDistance = cellRadius * SAMPLE_SEARCH_RADII;
  let changed = false;

  for (let index = 0; index < position.count; index += 1) {
    const originalY = nativeY[index];
    if (!Number.isFinite(originalY)) continue;

    const worldX = group.position.x + position.getX(index);
    const worldZ = group.position.z + position.getZ(index);
    const key = terrainVertexKey(worldX, worldZ);
    const exactHeight = centerSurface.heights.get(key);
    let nextY = originalY;

    if (Number.isFinite(exactHeight)) {
      nextY = exactHeight;
    } else {
      const boundaryDistance = distanceOutsideHexFootprint(worldX, worldZ, width, height);
      if (boundaryDistance <= maximumBoundaryDistance) {
        const nearest = nearestHeightSample(
          worldX,
          worldZ,
          centerSurface.samples,
          sampleDistance,
        );
        if (nearest !== undefined) {
          nextY = blendBoundaryHeight(
            originalY,
            nearest.height,
            boundaryDistance,
            cellRadius,
            BLEND_ROWS,
          );
        }
      }
    }

    if (Math.abs(position.getY(index) - nextY) <= 1e-9) continue;
    position.setY(index, nextY);
    changed = true;
  }

  if (changed) {
    position.needsUpdate = true;
    geometry.computeVertexNormals();
  }
  const normalsChanged = copySharedNormals(mesh, group, centerSurface);
  if (changed || normalsChanged) {
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox?.();
  }
  return changed || normalsChanged;
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

  const surfaces = {
    land: centerVertexHeights(view.terrainMesh),
    water: centerVertexHeights(view.waterMesh),
  };
  if (surfaces.land.samples.length === 0 && surfaces.water.samples.length === 0) return false;

  const radius = hexCellRadius(width, height);
  let changed = false;
  for (const group of preview.children.filter((entry) => entry?.isGroup)) {
    for (const mesh of group.children) {
      const centerSurface = mesh.name === "neighbor-hex-water" ? surfaces.water : surfaces.land;
      if (centerSurface.samples.length === 0) continue;
      changed = stitchMesh(mesh, group, centerSurface, width, height, radius) || changed;
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
