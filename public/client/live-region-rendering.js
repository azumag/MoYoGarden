import * as THREE from "three";
import { disposeObject, hash2 } from "./shared.js";
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

function createNeighborResourceGlyph(proxy, tile) {
  const glyph = new THREE.Group();
  glyph.name = "MoyoNeighborResourceGlyph";
  glyph.userData.moyoNeighborResourceGlyph = true;

  let low;
  if (tile.resource.kind === "wood") {
    low = proxy.makeLowTree(tile);
  } else if (tile.resource.kind === "stone") {
    low = proxy.makeLowRock(tile);
  } else {
    low = proxy.makeBush(false);
    low.scale.setScalar(0.76);
  }
  low.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = false;
    object.receiveShadow = true;
  });
  glyph.add(low);
  glyph.rotation.y = hash2(tile.x, tile.y, 99) * Math.PI * 2;
  glyph.rotation.z = (hash2(tile.x, tile.y, 213) - 0.5) * 0.052;
  proxy.resourceRoot.add(glyph);
  return { lod: glyph, kind: tile.resource.kind, authored: false };
}

function createNeighborStructureGlyph(proxy, structure, faction) {
  const glyph = proxy.makeLowBuilding(structure.type, faction?.color || "#999999");
  glyph.name = "MoyoNeighborStructureGlyph";
  glyph.userData.moyoNeighborStructureGlyph = true;
  glyph.userData.structureId = structure.id;
  glyph.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = false;
    object.receiveShadow = true;
  });
  proxy.structureRoot.add(glyph);
  return {
    lod: glyph,
    high: null,
    medium: null,
    low: glyph,
    type: structure.type,
    factionId: structure.factionId,
  };
}

function animateNeighborAgentGlyph(entry, time, tickMs) {
  const duration = Math.max(300, tickMs * 0.82);
  const amount = Math.max(0, Math.min(1, (time - entry.start) / duration));
  entry.lod.position.lerpVectors(entry.from, entry.to, amount);

  // Keep the radius-one population visibly alive without paying for authored
  // mixers or limb traversal. A tiny local bob/lean on the shared low-detail
  // shell matches the focused region's locomotion language while leaving the
  // root position exact for the next snapshot interpolation.
  const shell = entry.shell;
  if (!shell) return;
  const moving = entry.from.distanceToSquared(entry.to) > 0.001
    || /moving|travel|gather|haul/i.test(entry.agent?.status || "");
  const position = entry.agent?.position || { x: 0, y: 0 };
  const phase = time * 0.0075
    + hash2(position.x, position.y, entry.agent?.id?.length || 0) * Math.PI * 2;
  shell.position.y = moving
    ? Math.abs(Math.sin(phase)) * 0.025
    : Math.sin(phase * 0.2) * 0.004;
  shell.rotation.z = moving ? Math.sin(phase) * 0.025 : 0;
}

function createNeighborAgentGlyph(proxy, agent, faction) {
  // Keep neighbor BOTs cheap, but use the exact same low-detail character
  // vocabulary as the focused region. This preserves faction cloth, skin tone,
  // proportions, and role headgear without cloning high/medium authored GLTFs.
  let shell = typeof proxy.makeLowAgent === "function"
    ? proxy.makeLowAgent(faction?.color || "#999999", agent.role)
    : null;

  // Compatibility fallback for an unexpectedly incomplete proxy. Production
  // WorldView exposes makeLowAgent(), so this path should not be used normally.
  if (!shell) {
    shell = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.1, 0.82, 6),
      new THREE.MeshBasicMaterial({
        color: faction?.color || "#999999",
        toneMapped: false,
      }),
    );
    body.position.y = 0.58;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xd7ad8b,
        toneMapped: false,
      }),
    );
    head.position.y = 1.18;
    shell.add(body, head);
  }

  const glyph = new THREE.Group();
  glyph.name = "MoyoNeighborAgentGlyph";
  glyph.userData.moyoNeighborGlyph = true;
  shell.name = "MoyoNeighborAgentShell";
  shell.scale.setScalar(0.8);
  shell.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = false;
    object.receiveShadow = true;
  });
  glyph.add(shell);

  const ring = new THREE.Object3D();
  ring.visible = false;
  glyph.add(ring);
  proxy.agentRoot.add(glyph);

  const target = proxy.worldPosition(agent.position, 0);
  const now = performance.now();
  glyph.position.copy(target);
  return {
    lod: glyph,
    high: null,
    medium: null,
    low: shell,
    shell,
    ring,
    contactShadow: null,
    authoredKey: null,
    mixer: null,
    idleAction: null,
    moveAction: null,
    activeAction: null,
    lastMixerTime: now,
    from: target.clone(),
    to: target.clone(),
    start: now,
    agent,
    role: agent.role,
    factionId: agent.factionId,
  };
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
  // Neighbor regions can expose hundreds of natural-resource cells. Their
  // high/medium authored meshes add clone/material work even though the center
  // region remains the visual focus. Reuse the existing low-detail tree/rock/
  // forage silhouettes and skip authored nature clones and shadow casting here.
  proxy.createResource = (tile) => createNeighborResourceGlyph(proxy, tile);
  // Structures in the live radius-one ring are also contextual rather than the
  // visual focus. Keep their type/faction silhouette and construction progress,
  // but avoid cloning authored high/medium building shells for every neighbor.
  proxy.createStructure = (structure, faction) =>
    createNeighborStructureGlyph(proxy, structure, faction);
  proxy.createAgent = (agent, faction) => createNeighborAgentGlyph(proxy, agent, faction);
  // Neighbor BOTs have no mixer, limb animation, contact shadow, or selection
  // ring animation. Keep only root interpolation plus the cheap shell-level
  // locomotion cue while sharing the focused region's low-detail vocabulary.
  proxy.animateAgent = (entry, time) => animateNeighborAgentGlyph(entry, time, proxy.tickMs);
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

function snapshotTick(state) {
  const tick = state?.tick;
  return Number.isFinite(tick) ? tick : undefined;
}

function snapshotRevision(state) {
  const revision = state?.revision;
  return Number.isFinite(revision) ? revision : undefined;
}

function isStaleSnapshot(proxy, state) {
  const currentTick = snapshotTick(proxy?.state);
  const incomingTick = snapshotTick(state);
  if (currentTick === undefined) return false;
  if (incomingTick === undefined) return true;
  if (incomingTick !== currentTick) return incomingTick < currentTick;

  const currentRevision = snapshotRevision(proxy?.state);
  if (currentRevision === undefined) return false;
  const incomingRevision = snapshotRevision(state);
  return incomingRevision === undefined || incomingRevision < currentRevision;
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

function windowRegionIds(payload, centerRegionId) {
  const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
  const ids = new Set();
  for (const chunk of chunks) {
    if (typeof chunk?.regionId !== "string" || chunk.regionId === centerRegionId) continue;
    ids.add(chunk.regionId);
  }
  return ids;
}

function windowPlacements(payload, centerRegionId) {
  const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
  const center = chunks.find((chunk) =>
    chunk?.regionId === centerRegionId && finiteHexOrigin(chunk?.hexOrigin)
  );
  const placements = new Map();
  if (!center) return placements;

  for (const chunk of chunks) {
    if (
      typeof chunk?.regionId !== "string"
      || chunk.regionId === centerRegionId
      || !finiteHexOrigin(chunk?.hexOrigin)
    ) continue;
    placements.set(chunk.regionId, {
      offsetX: chunk.hexOrigin.x - center.hexOrigin.x,
      offsetZ: chunk.hexOrigin.y - center.hexOrigin.y,
    });
  }
  return placements;
}

function windowEntries(payload, centerRegionId) {
  const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
  const placements = windowPlacements(payload, centerRegionId);
  const entries = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const placement = placements.get(chunk?.regionId);
    if (
      placement === undefined
      || seen.has(chunk?.regionId)
      || !chunk?.state?.agents
      || !chunk?.state?.structures
      || !chunk?.state?.tiles
    ) continue;
    seen.add(chunk.regionId);
    entries.push({
      regionId: chunk.regionId,
      state: chunk.state,
      ...placement,
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
    const requestedIds = windowRegionIds(payload, centerRegionId);
    const placements = windowPlacements(payload, centerRegionId);
    const nextEntries = windowEntries(payload, centerRegionId);
    for (const [regionId, entry] of this.entries) {
      // A live-window request can return an error/partial chunk for one neighbor.
      // Keep its last-known graphics while the region is still part of this
      // window; the next healthy snapshot will update it in place. Placement is
      // independent of simulation state, so rebase retained graphics immediately
      // when the center region changes instead of leaving them at the old offset.
      if (requestedIds.has(regionId)) {
        const placement = placements.get(regionId);
        if (placement !== undefined) {
          entry.group.position.set(placement.offsetX, 0, placement.offsetZ);
        }
        continue;
      }
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
      } else if (!isStaleSnapshot(entry.proxy, next.state)) {
        // Same-region live window requests can overlap near their timeout boundary
        // or during a soft handoff. Never let a slower, older response roll BOT,
        // structure, or resource graphics back after a newer tick was rendered.
        // Once a rendered state has version metadata, fail closed on an incoming
        // snapshot that omits it or regresses a same-tick revision.
        syncProxy(entry.proxy, next.state, tickMs);
      }
      // Placement metadata is independent of simulation tick freshness, so even
      // a stale state response may carry the correct offset after camera rebase.
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
