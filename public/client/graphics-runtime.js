import { frameIsDue } from './graphics-settings.js';

const installed = new WeakSet();

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
    return createWanderer(color, role, 'low');
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
