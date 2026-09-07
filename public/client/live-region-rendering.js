import * as THREE from "three";
import { disposeObject } from "./shared.js";
import { WorldView } from "./world-view.js";

const controllers = new WeakMap();
const FRAME_PATCH_KEY = "__moyoLiveRegionFramePatched";

function finiteHexOrigin(value) {
  return value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y);
}

function previewSurfaceHeight(tile) {
  if (!tile || tile.terrain === "water") return -0.24;
  if (Number.isFinite(tile.elevation)) {
    return 0.015 + Math.pow(Math.max(0, Math.min(1, tile.elevation)), 1.18) * 0.82;
  }
  if (tile.terrain === "hill") return 0.54;
  if (tile.terrain === "forest") return 0.11;
  return 0.015;
}

function surfaceHeightMap(state) {
  const result = new Map();
  for (const tile of state?.tiles ?? []) {
    if (!Number.isFinite(tile?.x) || !Number.isFinite(tile?.y)) continue;
    result.set(`${tile.x}:${tile.y}`, previewSurfaceHeight(tile));
  }
  return result;
}
function createProxy(view, group, state, tickMs) {
  const proxy = Object.create(view);
  proxy.worldRoot = group;
  proxy.resourceRoot = new THREE.Group();
  proxy.structureRoot = new THREE.Group();
  proxy.agentRoot = new THREE.Group();
  proxy.state = state;
  proxy.tickMs = tickMs;
  proxy.surfaceHeightMap = surfaceHeightMap(state);
  proxy.resourceObjects = new Map();
  proxy.structureObjects = new Map();
  proxy.agentObjects = new Map();
  proxy.selectedAgentId = null;
  proxy.onSelect = () => {};
  proxy.markShadowsDirty = () => {};
  group.add(proxy.resourceRoot, proxy.structureRoot, proxy.agentRoot);
  proxy.syncResources(state);
  proxy.syncStructures(state);
  proxy.syncAgents(state);
  return proxy;
}

function syncProxy(proxy, state, tickMs) {
  proxy.state = state;
  proxy.tickMs = tickMs;
  proxy.surfaceHeightMap = surfaceHeightMap(state);
  proxy.syncResources(state);
  proxy.syncStructures(state);
  proxy.syncAgents(state);
}
function disposeProxy(entry) {
  for (const agent of entry.proxy.agentObjects.values()) {
    entry.proxy.disposeAgentEntry(agent);
  }
  entry.proxy.agentObjects.clear();
  for (const map of [entry.proxy.resourceObjects, entry.proxy.structureObjects]) {
    for (const object of map.values()) disposeObject(object.lod);
    map.clear();
  }
  entry.group.removeFromParent();
  disposeObject(entry.group);
}

function windowEntries(payload, centerRegionId) {
  const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
  const center = chunks.find((chunk) =>
    chunk?.regionId === centerRegionId && finiteHexOrigin(chunk?.hexOrigin)
  );
  if (!center) return [];

  const entries = [];
  const seen = new Set();
  for (const chunk of chunks) {
    if (
      chunk?.regionId === centerRegionId
      || seen.has(chunk?.regionId)
      || !finiteHexOrigin(chunk?.hexOrigin)
      || !chunk?.state?.agents
      || !chunk?.state?.structures
      || !chunk?.state?.tiles
    ) continue;
    seen.add(chunk.regionId);
    entries.push({
      regionId: chunk.regionId,
      state: chunk.state,
      offsetX: chunk.hexOrigin.x - center.hexOrigin.x,
      offsetZ: chunk.hexOrigin.y - center.hexOrigin.y,
    });
    if (entries.length >= 6) break;
  }
  return entries;
}
class LiveNeighborSimulation {
  constructor(view) {
    this.view = view;
    this.root = new THREE.Group();
    this.root.name = "live-neighbor-simulation";
    this.entries = new Map();
    this.centerRegionId = null;
    view.worldRoot.add(this.root);
  }

  setCenter(regionId) {
    this.centerRegionId = regionId;
    this.root.visible = false;
    const duplicate = this.entries.get(regionId);
    if (duplicate) {
      disposeProxy(duplicate);
      this.entries.delete(regionId);
    }
  }

  syncWindow(payload, centerRegionId, tickMs) {
    const nextEntries = windowEntries(payload, centerRegionId);
    const liveIds = new Set(nextEntries.map((entry) => entry.regionId));
    for (const [regionId, entry] of this.entries) {
      if (liveIds.has(regionId)) continue;
      disposeProxy(entry);
      this.entries.delete(regionId);
    }

    for (const next of nextEntries) {
      let entry = this.entries.get(next.regionId);
      if (!entry) {
        const group = new THREE.Group();
        group.name = `live-neighbor-region:${next.regionId}`;
        group.userData.moyoRegionId = next.regionId;
        this.root.add(group);
        entry = { group, proxy: createProxy(this.view, group, next.state, tickMs) };
        this.entries.set(next.regionId, entry);
      } else {
        syncProxy(entry.proxy, next.state, tickMs);
      }
      entry.group.position.set(next.offsetX, 0, next.offsetZ);
    }
    this.centerRegionId = centerRegionId;
    this.root.visible = true;
    this.view.markShadowsDirty();
  }
  refreshModelType(key) {
    for (const entry of this.entries.values()) {
      entry.proxy.refreshModelType(key);
    }
    this.view.markShadowsDirty();
  }

  animate(time) {
    for (const entry of this.entries.values()) {
      for (const agent of entry.proxy.agentObjects.values()) {
        entry.proxy.animateAgent(agent, time);
      }
    }
  }

  clear() {
    for (const entry of this.entries.values()) disposeProxy(entry);
    this.entries.clear();
    this.root.visible = false;
  }
}

if (!WorldView.prototype[FRAME_PATCH_KEY]) {
  const baseFrame = WorldView.prototype.frame;
  WorldView.prototype.frame = function frameWithLiveNeighbors(time) {
    controllers.get(this)?.animate(time);
    return baseFrame.call(this, time);
  };
  Object.defineProperty(WorldView.prototype, FRAME_PATCH_KEY, {
    value: true,
    configurable: false,
    enumerable: false,
  });
}

export function createLiveNeighborSimulation(view) {
  const controller = new LiveNeighborSimulation(view);
  controllers.set(view, controller);
  return controller;
}
