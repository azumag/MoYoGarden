import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
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

test('live neighbor low-detail BOTs keep a readable minimum scale without adding LOD work', () => {
  class View {
    constructor(worldRootName = '') {
      this.quality = { frameRate: 60 };
      this.worldRoot = { name: worldRootName };
    }
    frame() {}
    enableShadows() {}
    initializeEnvironment() {}
    makeLowAgent() {}
  }
  class Models { clone() { return {}; } async load() { return {}; } }
  const calls = [];
  installGraphicsRuntime(View, Models, { loadModels: true }, {
    createWanderer(color, role, detail) {
      calls.push([color, role, detail]);
      const root = new THREE.Group();
      root.name = 'BaseLowAgent';
      return root;
    },
    styleAsset: value => value,
  });

  const focused = new View();
  const neighbor = new View('live-neighbor-region:garden-2');
  const focusedLow = focused.makeLowAgent('#578ba3', 'scout');
  const neighborLow = neighbor.makeLowAgent('#578ba3', 'scout');

  assert.equal(focusedLow.name, 'BaseLowAgent');
  assert.equal(neighborLow.name, 'MoyoReadableNeighborAgent');
  assert.equal(neighborLow.userData.moyoReadableNeighborAgent, true);
  assert.equal(neighborLow.children.length, 1);
  assert.equal(neighborLow.children[0].name, 'BaseLowAgent');
  assert.equal(neighborLow.children[0].scale.x, 2);
  assert.equal(neighborLow.children[0].scale.y, 2);
  assert.equal(neighborLow.children[0].scale.z, 2);
  assert.deepEqual(calls, [
    ['#578ba3', 'scout', 'low'],
    ['#578ba3', 'scout', 'low'],
  ]);
});
