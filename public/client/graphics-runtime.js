import * as THREE from 'three';
import { frameIsDue } from './graphics-settings.js';

const installed = new WeakSet();
const LIVE_NEIGHBOR_REGION_PREFIX = 'live-neighbor-region:';
const LIVE_NEIGHBOR_LOW_DETAIL_SCALE = 1.35;

function readableLowAgent(view, createWanderer, color, role) {
  const agent = createWanderer(color, role, 'low');
  if (!view.worldRoot?.name?.startsWith(LIVE_NEIGHBOR_REGION_PREFIX)) return agent;

  // The live radius-one renderer applies its own 0.8 shell scale. Keep the
  // actual low-detail model slightly larger inside that shell so adjacent-region
  // BOTs remain recognisably human at normal camera distances instead of
  // collapsing into dark points. This wrapper adds no draw calls or mixers.
  const wrapper = new THREE.Group();
  wrapper.name = 'MoyoReadableNeighborAgent';
  wrapper.userData.moyoReadableNeighborAgent = true;
  agent.scale.setScalar(LIVE_NEIGHBOR_LOW_DETAIL_SCALE);
  wrapper.add(agent);
  return wrapper;
}

// Same pre-start extension point as the existing atmosphere/hex renderers.
// Keep settings fixed for this view's lifetime; applying settings reloads once.
export function installGraphicsRuntime(WorldView, ModelLibrary, quality, { createWanderer, styleAsset }) {
  if (installed.has(WorldView)) return;
  installed.add(WorldView);
  const frame = WorldView.prototype.frame;
  WorldView.prototype.frame = function(time) {
    this.graphicsFrameClock ??= {};
    if (!frameIsDue(this.graphicsFrameClock, time, this.quality.frameRate, globalThis.document?.hidden)) return;
    return frame.call(this, time);
  };
  const shadows = WorldView.prototype.enableShadows;
  WorldView.prototype.enableShadows = function() {
    if (this.quality.shadowsEnabled === false) return;
    return shadows.call(this);
  };
  const environment = WorldView.prototype.initializeEnvironment;
  WorldView.prototype.initializeEnvironment = function() {
    if (this.quality.environmentEnabled === false) return Promise.resolve();
    return environment.call(this);
  };
  WorldView.prototype.makeLowAgent = function(color, role) {
    return readableLowAgent(this, createWanderer, color, role);
  };

  const clone = ModelLibrary.prototype.clone;
  ModelLibrary.prototype.clone = function(name, options = {}) {
    // The previous toy-proportioned authored override must not replace the new
    // silhouette after an asynchronous GLB load or when LOD changes.
    if (name.startsWith('authored:agent-')) return null;
    if (name === 'settler') {
      return createWanderer(options.factionColor, options.role, quality.loadModels === false ? 'low' : options.detail);
    }
    return styleAsset(clone.call(this, name, options), name);
  };
  const load = ModelLibrary.prototype.load;
  ModelLibrary.prototype.load = async function(options) {
    if (quality.loadModels !== false) return load.call(this, options);
    // Low mode remains fully procedural instead of fetching every authored GLB.
    this.lastLoadResult = { loaded: [], failed: [] };
    return this.lastLoadResult;
  };
}
