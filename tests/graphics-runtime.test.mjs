import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installGraphicsRuntime } from '../public/client/graphics-runtime.js';

test('light mode skips shadows, environment, GLB fetches and duplicate frames', async () => {
  const calls = [];
  class View {
    constructor() { this.quality = { shadowsEnabled: false, environmentEnabled: false, frameRate: 30 }; }
    frame(time) { calls.push(['frame', time]); }
    enableShadows() { calls.push(['shadow']); }
    initializeEnvironment() { calls.push(['environment']); }
    makeLowAgent() {}
  }
  class Models { clone(key) { return { key }; } async load() { calls.push(['fetch']); } }
  installGraphicsRuntime(View, Models, { loadModels: false }, { createWanderer: (...args) => ({ args }), styleAsset: root => root });
  const view = new View();
  view.enableShadows(); await view.initializeEnvironment();
  view.frame(0); view.frame(16); view.frame(34);
  const models = new Models();
  assert.deepEqual(await models.load(), { loaded: [], failed: [] });
  assert.deepEqual(calls, [['frame', 0], ['frame', 34]]);
  assert.equal(models.clone('authored:agent-worker'), null);
  assert.equal(models.clone('settler', { factionColor: '#abc', role: 'scout', detail: 'mid' }).args[2], 'low');
  assert.deepEqual(models.clone('buildings'), { key: 'buildings' });
});

test('normal mode retains enhancement and load callbacks and does not stack wrappers', async () => {
  let frames = 0, shadows = 0, environments = 0;
  class View {
    constructor() { this.quality = { frameRate: 60 }; }
    frame() { frames++; } enableShadows() { shadows++; }
    initializeEnvironment() { environments++; } makeLowAgent() {}
  }
  class Models { clone() { return {}; } async load(options) { options.onProgress(); return 'loaded'; } }
  const factories = { createWanderer() { return {}; }, styleAsset: value => value };
  installGraphicsRuntime(View, Models, { loadModels: true }, factories);
  const installed = View.prototype.frame;
  installGraphicsRuntime(View, Models, { loadModels: true }, factories);
  assert.equal(installed, View.prototype.frame);
  const view = new View(); view.frame(0); view.enableShadows(); await view.initializeEnvironment();
  let progress = 0;
  assert.equal(await new Models().load({ onProgress() { progress++; } }), 'loaded');
  assert.deepEqual([frames, shadows, environments, progress], [1, 1, 1, 1]);
});
