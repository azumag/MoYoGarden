import { hexCellRadius } from "./hex-grid.js";
import {
  blendBoundaryHeight,
  distanceOutsideHexFootprint,
  interpolateHexBoundaryHeight,
  nearestHeightSample,
} from "./hex-terrain-blend.js";
import { adjacentHexPreviewPairs } from "./neighbor-preview-layout.js";
import { terrainVertexKey } from "./terrain-stitch.js";
import { WorldView } from "./world-view.js";

const BLEND_ROWS = 2.25;
const SAMPLE_SEARCH_RADII = 3.4;
const CENTER_ORIGIN = Object.freeze({ x: 0, z: 0 });

function centerVertexHeights(mesh) {
  const heights = new Map();
  const normals = new Map();
  const colors = new Map();
  const samplesByKey = new Map();
  const geometry = mesh?.geometry;
  const position = geometry?.getAttribute("position");
  const normal = geometry?.getAttribute("normal");
  const color = geometry?.getAttribute("color");
  if (!position) return { heights, normals, colors, samples: [] };

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
      if (color) {
        colors.set(key, {
          r: color.getX(index),
          g: color.getY(index),
          b: color.getZ(index),
        });
      }
    }
  }
  return { heights, normals, colors, samples: [...samplesByKey.values()] };
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

function sourceLocalPosition(group, position, index, sourceOrigin) {
  return {
    x: group.position.x + position.getX(index) - sourceOrigin.x,
    z: group.position.z + position.getZ(index) - sourceOrigin.z,
  };
}

function copySharedAppearance(mesh, group, sourceSurface, sourceOrigin) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const color = geometry.getAttribute("color");
  if (!position) return false;

  let changed = false;
  let normalsChanged = false;
  let colorsChanged = false;
  for (let index = 0; index < position.count; index += 1) {
    const local = sourceLocalPosition(group, position, index, sourceOrigin);
    const key = terrainVertexKey(local.x, local.z);
    const sourceNormal = sourceSurface.normals.get(key);
    if (normal && sourceNormal) {
      normal.setXYZ(index, sourceNormal.x, sourceNormal.y, sourceNormal.z);
      normalsChanged = true;
      changed = true;
    }
    const sourceColor = sourceSurface.colors.get(key);
    if (color && sourceColor) {
      color.setXYZ(index, sourceColor.r, sourceColor.g, sourceColor.b);
      colorsChanged = true;
      changed = true;
    }
  }
  if (normalsChanged) normal.needsUpdate = true;
  if (colorsChanged) color.needsUpdate = true;
  return changed;
}

function stitchMesh(mesh, group, sourceSurface, sourceOrigin, width, height, cellRadius) {
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

    const local = sourceLocalPosition(group, position, index, sourceOrigin);
    const key = terrainVertexKey(local.x, local.z);
    const exactHeight = sourceSurface.heights.get(key);
    let nextY = originalY;

    if (Number.isFinite(exactHeight)) {
      nextY = exactHeight;
    } else {
      const boundaryDistance = distanceOutsideHexFootprint(local.x, local.z, width, height);
      if (boundaryDistance <= maximumBoundaryDistance) {
        const boundary = interpolateHexBoundaryHeight(
          local.x,
          local.z,
          sourceSurface.samples,
          width,
          height,
          sampleDistance,
        );
        const target = boundary ?? nearestHeightSample(
          local.x,
          local.z,
          sourceSurface.samples,
          sampleDistance,
        );
        if (target !== undefined) {
          nextY = blendBoundaryHeight(
            originalY,
            target.height,
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
  const appearanceChanged = copySharedAppearance(mesh, group, sourceSurface, sourceOrigin);
  if (changed || appearanceChanged) {
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox?.();
  }
  return changed || appearanceChanged;
}

function previewPlacement(group) {
  const regionId = group?.userData?.moyoRegionId;
  const axial = group?.userData?.moyoAxial;
  if (
    typeof regionId !== "string"
    || !Number.isInteger(axial?.q)
    || !Number.isInteger(axial?.r)
  ) return undefined;
  return { regionId, axial, group };
}

function meshNamed(group, name) {
  return group?.children?.find((entry) => entry?.isMesh && entry.name === name);
}

function stitchLoadedPreviewPairs(groups, width, height, cellRadius) {
  const placements = groups.flatMap((group) => {
    const placement = previewPlacement(group);
    return placement === undefined ? [] : [placement];
  });
  let changed = false;

  for (const [source, target] of adjacentHexPreviewPairs(placements)) {
    const sourceOrigin = { x: source.group.position.x, z: source.group.position.z };
    for (const name of ["neighbor-hex-land", "neighbor-hex-water"]) {
      const sourceMesh = meshNamed(source.group, name);
      const targetMesh = meshNamed(target.group, name);
      if (!sourceMesh || !targetMesh) continue;
      const sourceSurface = centerVertexHeights(sourceMesh);
      if (sourceSurface.samples.length === 0) continue;
      changed = stitchMesh(
        targetMesh,
        target.group,
        sourceSurface,
        sourceOrigin,
        width,
        height,
        cellRadius,
      ) || changed;
    }
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

  const surfaces = {
    land: centerVertexHeights(view.terrainMesh),
    water: centerVertexHeights(view.waterMesh),
  };
  if (surfaces.land.samples.length === 0 && surfaces.water.samples.length === 0) return false;

  const radius = hexCellRadius(width, height);
  const groups = preview.children.filter((entry) => entry?.isGroup);
  let changed = false;

  // First make the active center region authoritative at every center/preview
  // seam. This also fixes the shared corner before preview-to-preview stitching.
  for (const group of groups) {
    for (const mesh of group.children) {
      const centerSurface = mesh.name === "neighbor-hex-water" ? surfaces.water : surfaces.land;
      if (centerSurface.samples.length === 0) continue;
      changed = stitchMesh(
        mesh,
        group,
        centerSurface,
        CENTER_ORIGIN,
        width,
        height,
        radius,
      ) || changed;
    }
  }

  // Loaded radius-1 previews can also touch each other (for example garden-2
  // and garden-3 while garden-1 is active). Stitch those axial-neighbor seams
  // too; otherwise their independently rendered height fields expose a dark
  // vertical cut even though both chunks are individually welded to the center.
  changed = stitchLoadedPreviewPairs(groups, width, height, radius) || changed;

  preview.userData.moyoHexTerrainStitchRevision = revision;
  if (changed) view.__moyoNavigationPreview = undefined;
  return changed;
}

const previousMarkShadowsDirty = WorldView.prototype.markShadowsDirty;
WorldView.prototype.markShadowsDirty = function markShadowsDirtyWithHexTerrainStitching() {
  previousMarkShadowsDirty.call(this);
  stitchHexNeighborTerrain(this);
};
