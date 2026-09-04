import * as THREE from "three";
import { clamp } from "./shared.js";
import { WorldView } from "./world-view.js";
import { resolveNavigationBounds } from "./navigation-bounds.js";

function cachedPreviewBounds(view) {
  const preview = view.worldRoot?.getObjectByName("neighbor-region-preview");
  if (!preview) {
    view.__moyoNavigationPreview = undefined;
    return undefined;
  }

  if (view.__moyoNavigationPreview?.root === preview) {
    return view.__moyoNavigationPreview.bounds;
  }

  const box = new THREE.Box3().setFromObject(preview);
  const bounds = box.isEmpty()
    ? undefined
    : {
        min: { x: box.min.x, z: box.min.z },
        max: { x: box.max.x, z: box.max.z },
      };
  view.__moyoNavigationPreview = { root: preview, bounds };
  return bounds;
}

WorldView.prototype.clampTarget = function clampTargetToLoadedWindow() {
  if (!this.state) return;
  const bounds = resolveNavigationBounds(this.state, cachedPreviewBounds(this));
  this.cameraState.target.x = clamp(this.cameraState.target.x, bounds.minX, bounds.maxX);
  this.cameraState.target.z = clamp(this.cameraState.target.z, bounds.minZ, bounds.maxZ);
};
