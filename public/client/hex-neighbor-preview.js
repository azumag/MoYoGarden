import * as THREE from "three";
import { applyHexFootprintClipping } from "./hex-footprint-rendering.js";
import {
  buildNeighborPreviewPlacements,
  resolvePhysicalPreviewPlacement,
} from "./neighbor-preview-layout.js";
import { regionMetaUrl } from "./region-navigation.js";
import { disposeObject } from "./shared.js";
import { WorldView } from "./world-view.js";

let topologyRegions = [];
let topologyCenterRegionId;
let topologyRequest;
let topologyRequestCenterRegionId;

function ensureTopology(centerRegionId) {
  if (!centerRegionId || location.protocol === "file:") return Promise.resolve([]);
  if (topologyCenterRegionId === centerRegionId && topologyRegions.length > 0) {
    return Promise.resolve(topologyRegions);
  }
  if (topologyRequest && topologyRequestCenterRegionId === centerRegionId) return topologyRequest;

  const requestedCenter = centerRegionId;
  topologyRequestCenterRegionId = requestedCenter;
  topologyRequest = fetch(regionMetaUrl(requestedCenter, 1), { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`meta HTTP ${response.status}`);
      const meta = await response.json();
      const regions = meta?.world?.regionTopology?.regions;
      if (topologyRequestCenterRegionId === requestedCenter && Array.isArray(regions)) {
        topologyRegions = regions;
        topologyCenterRegionId = requestedCenter;
      }
      return topologyCenterRegionId === requestedCenter ? topologyRegions : [];
    })
    .catch((error) => {
      console.debug("MoYoGarden hex neighbor topology unavailable", error);
      return [];
    })
    .finally(() => {
      if (topologyRequestCenterRegionId === requestedCenter) {
        topologyRequest = undefined;
        topologyRequestCenterRegionId = undefined;
      }
    });
  return topologyRequest;
}

function cloneMaterial(material) {
  if (Array.isArray(material)) return material.map((entry) => entry.clone());
  return material?.clone?.() ?? material;
}

function cloneInstances(source, indexes, physicalOffset) {
  if (!source?.isInstancedMesh || indexes.length === 0) return null;
  const mesh = new THREE.InstancedMesh(
    source.geometry.clone(),
    cloneMaterial(source.material),
    indexes.length,
  );
  mesh.name = source.name;
  mesh.castShadow = source.castShadow;
  mesh.receiveShadow = source.receiveShadow;
  mesh.renderOrder = source.renderOrder;
  mesh.frustumCulled = source.frustumCulled;

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  indexes.forEach((sourceIndex, targetIndex) => {
    source.getMatrixAt(sourceIndex, matrix);
    matrix.elements[12] -= physicalOffset.x;
    matrix.elements[14] -= physicalOffset.z;
    mesh.setMatrixAt(targetIndex, matrix);
    if (source.instanceColor) {
      source.getColorAt(sourceIndex, color);
      mesh.setColorAt(targetIndex, color);
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

function upgradeNeighborPreview(view, preview) {
  if (!preview || preview.userData.moyoHexChunked) return false;
  const width = Number(view.state?.width);
  const height = Number(view.state?.height);
  const centerRegionId = view.state?.regionId;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0 || !centerRegionId) {
    return false;
  }

  const placements = buildNeighborPreviewPlacements(topologyRegions, centerRegionId);
  if (placements.length === 0) return false;
  const sources = preview.children.filter((object) => object?.isInstancedMesh && object.count > 0);
  if (sources.length === 0) return false;

  const buckets = new Map(placements.map((placement) => [placement.regionId, {
    placement,
    sourceIndexes: new Map(),
  }]));
  const matrix = new THREE.Matrix4();
  let total = 0;
  let matched = 0;

  for (const source of sources) {
    total += source.count;
    for (let index = 0; index < source.count; index += 1) {
      source.getMatrixAt(index, matrix);
      const placement = resolvePhysicalPreviewPlacement(
        placements,
        matrix.elements[12],
        matrix.elements[14],
        width,
        height,
      );
      if (!placement) continue;
      const bucket = buckets.get(placement.regionId);
      const indexes = bucket.sourceIndexes.get(source) ?? [];
      indexes.push(index);
      bucket.sourceIndexes.set(source, indexes);
      matched += 1;
    }
  }

  // Keep the legacy preview intact if an unknown chunk cannot be mapped safely.
  if (total === 0 || matched !== total) return false;

  const groups = [];
  for (const { placement, sourceIndexes } of buckets.values()) {
    if (sourceIndexes.size === 0) continue;
    const group = new THREE.Group();
    group.name = `neighbor-region-preview-chunk:${placement.regionId}`;
    group.position.set(placement.hexOffset.x, 0, placement.hexOffset.z);
    group.userData.moyoRegionId = placement.regionId;
    group.userData.moyoAxial = placement.axial;
    group.userData.moyoPhysicalOrigin = placement.physicalOrigin;
    group.userData.moyoHexOrigin = placement.hexOrigin;

    for (const [source, indexes] of sourceIndexes) {
      const mesh = cloneInstances(source, indexes, placement.physicalOffset);
      if (mesh) group.add(mesh);
    }
    applyHexFootprintClipping(
      group,
      width,
      height,
      placement.hexOffset.x,
      placement.hexOffset.z,
    );
    groups.push(group);
  }
  if (groups.length === 0) return false;

  for (const child of [...preview.children]) disposeObject(child);
  preview.add(...groups);
  preview.userData.moyoHexChunked = true;
  // The existing stitcher assumes one rectangular east/west preview mesh.
  // Do not let it weld across logically separate hex chunks.
  preview.userData.moyoTerrainStitched = true;
  view.__moyoNavigationPreview = undefined;
  if (view.renderer) view.renderer.localClippingEnabled = true;
  return true;
}

const baseMarkShadowsDirty = WorldView.prototype.markShadowsDirty;
WorldView.prototype.markShadowsDirty = function markShadowsDirtyWithHexNeighborPreview() {
  const preview = this.worldRoot?.getObjectByName("neighbor-region-preview");
  if (preview && !preview.userData.moyoHexChunked) {
    const centerRegionId = this.state?.regionId;
    if (centerRegionId && topologyCenterRegionId === centerRegionId && topologyRegions.length > 0) {
      upgradeNeighborPreview(this, preview);
    } else if (centerRegionId) {
      // Preserve the instanced source meshes until topology arrives; otherwise
      // the legacy seamless extension may weld them into one rectangular mesh.
      preview.userData.moyoTerrainStitched = true;
      void ensureTopology(centerRegionId).then(() => {
        if (preview.parent !== this.worldRoot || preview.userData.moyoHexChunked) return;
        if (this.state?.regionId !== centerRegionId) return;
        if (upgradeNeighborPreview(this, preview)) baseMarkShadowsDirty.call(this);
      });
    }
  }
  baseMarkShadowsDirty.call(this);
};
