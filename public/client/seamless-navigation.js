import * as THREE from "three";
import { resolveNavigationBounds } from "./navigation-bounds.js";
import { resolveRegionPrefetch, resolveRegionRebase } from "./region-navigation.js";
import { clamp, disposeObject } from "./shared.js";
import {
  buildWeldedPreviewSurface,
  collectBoundaryHeights,
  resolvePreviewCornerHeight,
  terrainVertexKey,
} from "./terrain-stitch.js";
import { WorldView } from "./world-view.js";

const REBASE_TIMEOUT_MS = 15_000;
const PREFETCH_MARGIN_TILES = 6;
const PREFETCH_REFRESH_MS = 60_000;
let regionLayout = [];
let regionLayoutRequest;
let pendingRebase;
let pendingRebaseTimer;
let rebaseInFlight = false;
const regionWarmAt = new Map();
const regionWarmRequests = new Map();

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

function stitchNeighborTerrainPreview(view) {
  const preview = view.worldRoot?.getObjectByName("neighbor-region-preview");
  if (!preview || preview.userData.moyoTerrainStitched) return;

  const land = preview.children.find((object) =>
    object.isInstancedMesh && object.geometry?.type === "BoxGeometry"
  );
  if (!land || land.count <= 0) {
    preview.userData.moyoTerrainStitched = true;
    return;
  }

  const centerPositions = view.terrainMesh?.geometry?.getAttribute("position")?.array;
  const boundaryHeights = collectBoundaryHeights(
    centerPositions,
    (view.state?.width ?? 0) / 2,
    (view.state?.height ?? 0) / 2,
  );
  const tileHeights = new Map();
  const entries = [];
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const boxHeight = Number(land.geometry?.parameters?.height) || 0.08;

  for (let index = 0; index < land.count; index += 1) {
    land.getMatrixAt(index, matrix);
    const x = matrix.elements[12];
    const y = matrix.elements[13] + boxHeight * 0.5;
    const z = matrix.elements[14];
    if (![x, y, z].every(Number.isFinite)) continue;
    const entryColor = land.instanceColor
      ? (land.getColorAt(index, color), color.clone())
      : new THREE.Color(0x71845a);
    tileHeights.set(terrainVertexKey(x, z), y);
    entries.push({ x, z, color: entryColor });
  }

  if (entries.length === 0) {
    preview.userData.moyoTerrainStitched = true;
    return;
  }

  const surface = buildWeldedPreviewSurface(
    entries,
    (x, z) => resolvePreviewCornerHeight(x, z, tileHeights, boundaryHeights),
  );
  if (surface.vertexCount === 0 || surface.indices.length === 0) {
    preview.userData.moyoTerrainStitched = true;
    return;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(surface.positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(surface.colors, 3));
  geometry.setIndex(surface.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = !Array.isArray(view.terrainMesh?.material) && view.terrainMesh?.material?.clone
    ? view.terrainMesh.material.clone()
    : new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.985,
        metalness: 0,
        envMapIntensity: 0.3,
      });
  material.vertexColors = true;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "neighbor-terrain-stitched";
  mesh.receiveShadow = true;
  preview.add(mesh);
  disposeObject(land);

  for (const object of preview.children) {
    if (!object.isInstancedMesh || object.geometry?.type !== "PlaneGeometry") continue;
    const width = Number(object.geometry?.parameters?.width);
    const height = Number(object.geometry?.parameters?.height);
    if (width >= 0.999 && height >= 0.999) continue;
    object.geometry.dispose?.();
    object.geometry = new THREE.PlaneGeometry(1, 1);
    object.computeBoundingSphere?.();
  }

  preview.userData.moyoTerrainStitched = true;
  view.__moyoNavigationPreview = undefined;
}

function clearPendingRebase() {
  clearTimeout(pendingRebaseTimer);
  pendingRebase = undefined;
  rebaseInFlight = false;
}

function ensureRegionLayout() {
  if (regionLayout.length > 0 || regionLayoutRequest || location.protocol === "file:") return;
  regionLayoutRequest = fetch("/api/meta", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`meta HTTP ${response.status}`);
      const meta = await response.json();
      const next = meta?.world?.regionLayout;
      if (Array.isArray(next)) regionLayout = next;
    })
    .catch((error) => {
      console.debug("MoYoGarden seamless region metadata unavailable", error);
    })
    .finally(() => {
      regionLayoutRequest = undefined;
    });
}

function warmRegion(regionId) {
  if (!regionId || location.protocol === "file:" || regionWarmRequests.has(regionId)) return;
  const lastWarm = regionWarmAt.get(regionId) ?? 0;
  if (Date.now() - lastWarm < PREFETCH_REFRESH_MS) return;

  regionWarmAt.set(regionId, Date.now());
  // /api/health is intentionally passive on the Worker, so it loads the Durable Object
  // without switching an idle neighbor back to active tick cadence. A normal snapshot
  // request marks the region active; cancel the body after headers to keep this warm-up
  // cheap while the existing window prefetch remains responsible for preview state.
  const request = fetch(`/api/world/snapshot?region=${encodeURIComponent(regionId)}`, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`warm snapshot HTTP ${response.status}`);
      await response.body?.cancel();
    })
    .catch((error) => {
      regionWarmAt.delete(regionId);
      console.debug(`MoYoGarden region prewarm failed for ${regionId}`, error);
    })
    .finally(() => {
      regionWarmRequests.delete(regionId);
    });
  regionWarmRequests.set(regionId, request);
}

function maybeWarmRegionAhead(view) {
  if (!view.state?.regionId) return;
  if (regionLayout.length === 0) {
    ensureRegionLayout();
    return;
  }
  const prefetch = resolveRegionPrefetch(
    regionLayout,
    view.state.regionId,
    {
      x: view.cameraState.target.x,
      z: view.cameraState.target.z,
    },
    PREFETCH_MARGIN_TILES,
  );
  if (prefetch?.regionId) warmRegion(prefetch.regionId);
}

function beginRegionRebase(view, transition) {
  if (rebaseInFlight || !transition?.regionId || transition.regionId === view.state?.regionId) return;
  const select = document.querySelector("#region-select");
  const reconnect = document.querySelector("#reconnect-button");
  if (!(select instanceof HTMLSelectElement) || !(reconnect instanceof HTMLButtonElement)) return;
  if (![...select.options].some((option) => option.value === transition.regionId)) return;

  pendingRebase = {
    fromRegion: view.state.regionId,
    toRegion: transition.regionId,
    offsetX: transition.offsetX,
    offsetZ: transition.offsetZ,
    expiresAt: Date.now() + REBASE_TIMEOUT_MS,
  };
  rebaseInFlight = true;
  select.value = transition.regionId;
  reconnect.click();
  pendingRebaseTimer = setTimeout(clearPendingRebase, REBASE_TIMEOUT_MS);
}

function maybeRebase(view) {
  if (rebaseInFlight || !view.state?.regionId) return;
  if (regionLayout.length === 0) {
    ensureRegionLayout();
    return;
  }
  const transition = resolveRegionRebase(regionLayout, view.state.regionId, {
    x: view.cameraState.target.x,
    z: view.cameraState.target.z,
  });
  if (transition) beginRegionRebase(view, transition);
}

const baseMarkShadowsDirty = WorldView.prototype.markShadowsDirty;
WorldView.prototype.markShadowsDirty = function markShadowsDirtyWithTerrainStitch() {
  stitchNeighborTerrainPreview(this);
  baseMarkShadowsDirty.call(this);
};

const baseSetState = WorldView.prototype.setState;
WorldView.prototype.setState = function setStateWithRegionRebase(state, tickMs) {
  const previousRegion = this.state?.regionId;
  const previousCamera = {
    yaw: this.cameraState.yaw,
    pitch: this.cameraState.pitch,
    distance: this.cameraState.distance,
    target: this.cameraState.target.clone(),
  };

  baseSetState.call(this, state, tickMs);

  if (
    !pendingRebase
    || pendingRebase.expiresAt < Date.now()
    || state?.regionId !== pendingRebase.toRegion
    || previousRegion !== pendingRebase.fromRegion
  ) {
    if (pendingRebase?.expiresAt < Date.now()) clearPendingRebase();
    return;
  }

  const { offsetX, offsetZ } = pendingRebase;
  clearPendingRebase();
  this.cameraState.yaw = previousCamera.yaw;
  this.cameraState.pitch = previousCamera.pitch;
  this.cameraState.distance = previousCamera.distance;
  this.cameraState.target.set(
    previousCamera.target.x - offsetX,
    previousCamera.target.y,
    previousCamera.target.z - offsetZ,
  );
  this.clampTarget();
};

WorldView.prototype.clampTarget = function clampTargetToLoadedWindow() {
  if (!this.state) return;
  const bounds = resolveNavigationBounds(this.state, cachedPreviewBounds(this));
  this.cameraState.target.x = clamp(this.cameraState.target.x, bounds.minX, bounds.maxX);
  this.cameraState.target.z = clamp(this.cameraState.target.z, bounds.minZ, bounds.maxZ);
  maybeWarmRegionAhead(this);
  maybeRebase(this);
};

ensureRegionLayout();
