import * as THREE from "three";
import { hexFootprintVertices } from "./hex-footprint.js";
import { WorldView } from "./world-view.js";

const planeCache = new Map();

export function createHexClippingPlanes(width, height, centerX = 0, centerZ = 0) {
  const key = `${width}:${height}:${centerX}:${centerZ}`;
  const cached = planeCache.get(key);
  if (cached) return cached;

  const vertices = hexFootprintVertices(width, height, centerX, centerZ);
  const center = new THREE.Vector3(centerX, 0, centerZ);
  const planes = vertices.map((start, index) => {
    const end = vertices[(index + 1) % vertices.length];
    const a = new THREE.Vector3(start.x, 0, start.z);
    const b = new THREE.Vector3(end.x, 0, end.z);
    const edge = b.clone().sub(a);
    const normal = new THREE.Vector3(-edge.z, 0, edge.x).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, a);
    if (plane.distanceToPoint(center) < 0) plane.negate();
    return plane;
  });
  planeCache.set(key, planes);
  return planes;
}

function clearClipMaterial(material) {
  if (!material) return;
  material.clippingPlanes = null;
  material.clipShadows = false;
  if (material.userData) delete material.userData.moyoHexClipKey;
  material.needsUpdate = true;
}

function clipMaterial(material, planes, key) {
  if (!material || material.userData?.moyoHexClipKey === key) return;
  material.clippingPlanes = planes;
  material.clipShadows = true;
  material.userData.moyoHexClipKey = key;
  material.needsUpdate = true;
}

export function applyHexFootprintClipping(root, width, height, centerX = 0, centerZ = 0) {
  if (!root || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return;
  }
  const key = `${width}:${height}:${centerX}:${centerZ}`;
  const planes = createHexClippingPlanes(width, height, centerX, centerZ);
  root.traverse((object) => {
    if (!object?.isMesh) return;
    if (object.userData?.moyoWeldedHexSurface || object.geometry?.userData?.moyoWeldedHexSurface) {
      if (Array.isArray(object.material)) {
        for (const material of object.material) clearClipMaterial(material);
      } else {
        clearClipMaterial(object.material);
      }
      return;
    }
    if (Array.isArray(object.material)) {
      for (const material of object.material) clipMaterial(material, planes, key);
    } else {
      clipMaterial(object.material, planes, key);
    }
  });
}

const baseSetState = WorldView.prototype.setState;
WorldView.prototype.setState = function setStateWithHexFootprint(state, tickMs) {
  baseSetState.call(this, state, tickMs);
  if (!state || !Number.isFinite(state.width) || !Number.isFinite(state.height)) return;

  if (this.renderer) this.renderer.localClippingEnabled = true;
  for (const child of this.worldRoot?.children ?? []) {
    if (child.name === "neighbor-region-preview") continue;
    applyHexFootprintClipping(child, state.width, state.height);
  }
  this.markShadowsDirty?.();
};
