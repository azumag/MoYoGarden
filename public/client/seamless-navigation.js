import * as THREE from "three";
import { resolveNavigationBounds } from "./navigation-bounds.js";
import { resolveRegionPrefetch, resolveRegionRebase } from "./region-navigation.js";
import { clamp } from "./shared.js";
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
  const request = fetch(`/api/health?region=${encodeURIComponent(regionId)}`, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`health HTTP ${response.status}`);
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
