import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GRAPHICS_STORAGE_KEY, normalizeGraphicsSettings, readGraphicsSettings,
  saveGraphicsSettings, clearGraphicsSettings, graphicsSettingsUrl,
  applyGraphicsOverrides, frameIsDue,
} from '../public/client/graphics-settings.js';

function memoryStorage() {
  const values = new Map([['unrelated', 'keep']]);
  return { values, getItem: k => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
}
const baseline = { id: 'high', label: 'HIGH', pixelRatioCap: 1.65, antialias: true,
  shadowSize: 2048, environmentSize: 128, detailDensity: 0.86, lodScale: 1 };

test('graphics preferences survive a new read without saving unrelated fields', () => {
  const storage = memoryStorage();
  assert.equal(saveGraphicsSettings({ preset: 'low', water: 'ripples', token: 'never-save' }, storage), true);
  assert.equal(readGraphicsSettings(storage).preset, 'low');
  assert.equal(readGraphicsSettings(storage).water, 'ripples');
  assert.equal(storage.values.get(GRAPHICS_STORAGE_KEY).includes('never-save'), false);
  assert.equal(storage.values.get('unrelated'), 'keep');
});

test('malformed, oversized, future and prototype-like settings safely fall back', () => {
  const storage = memoryStorage();
  for (const raw of ['{', 'null', '[]', 'x'.repeat(4097), '{"version":9,"preset":"ultra"}']) {
    storage.setItem(GRAPHICS_STORAGE_KEY, raw);
    assert.equal(readGraphicsSettings(storage).preset, 'auto');
  }
  const value = normalizeGraphicsSettings({ preset: '__proto__', resolution: 'Infinity', shadows: '999999', fps: '0' });
  assert.equal(value.preset, 'auto');
  assert.equal(value.resolution, 'auto');
  assert.equal(value.shadows, 'auto');
  assert.equal(value.fps, 'auto');
});

test('storage denial and unavailable storage do not break startup', () => {
  const denied = { getItem() { throw Error('SecurityError'); }, setItem() { throw Error('QuotaExceededError'); }, removeItem() { throw Error('SecurityError'); } };
  assert.equal(readGraphicsSettings(denied).preset, 'auto');
  assert.equal(saveGraphicsSettings({ preset: 'high' }, denied), false);
  assert.equal(saveGraphicsSettings({}, null), false);
  assert.equal(clearGraphicsSettings(denied), false);
});

test('reset removes only graphics preferences', () => {
  const storage = memoryStorage();
  saveGraphicsSettings({ preset: 'high' }, storage);
  assert.equal(clearGraphicsSettings(storage), true);
  assert.equal(storage.getItem(GRAPHICS_STORAGE_KEY), null);
  assert.equal(storage.getItem('unrelated'), 'keep');
});

test('saving from a diagnostic URL clears overrides but preserves region and hash', () => {
  const result = new URL(graphicsSettingsUrl('https://example.test/?region=garden-4&quality=high&safe=1&renderer=compat#agent'));
  assert.equal(result.searchParams.get('region'), 'garden-4');
  assert.equal(result.hash, '#agent');
  for (const key of ['quality', 'safe', 'renderer']) assert.equal(result.searchParams.has(key), false);
});

test('custom settings affect actual rendering budgets without mutating the profile', () => {
  const value = applyGraphicsOverrides(baseline, { resolution: '0.75', shadows: 'off', water: 'simple', vegetation: 'off', fps: '30' });
  assert.equal(value.pixelRatioCap, 0.75);
  assert.equal(value.antialias, false);
  assert.equal(value.shadowsEnabled, false);
  assert.equal(value.waterQuality, 'simple');
  assert.equal(value.detailDensity, 0);
  assert.equal(value.frameRate, 30);
  assert.equal(baseline.pixelRatioCap, 1.65);
});

test('safe URL cannot be made heavy by saved advanced overrides', () => {
  const low = { ...baseline, id: 'balanced', label: 'SAFE', pixelRatioCap: 1 };
  const value = applyGraphicsOverrides(low, { resolution: '2', shadows: '2048', water: 'ripples', vegetation: 'full', fps: '60' }, true);
  assert.equal(value.pixelRatioCap, 1);
  assert.equal(value.shadowsEnabled, false);
  assert.equal(value.environmentEnabled, false);
  assert.equal(value.loadModels, false);
  assert.equal(value.waterQuality, 'simple');
  assert.equal(value.detailDensity, 0);
  assert.equal(value.frameRate, 30);
});

test('frame pacing enforces 30 and 60 fps on a 144Hz display and resumes hidden tabs', () => {
  for (const fps of [30, 60]) {
    const clock = {};
    let frames = 0;
    for (let i = 0; i < 144; i++) if (frameIsDue(clock, i * 1000 / 144, fps)) frames++;
    assert.ok(Math.abs(frames - fps) <= 1, `${fps}: ${frames}`);
    assert.equal(frameIsDue(clock, 2000, fps, true), false);
    assert.equal(frameIsDue(clock, 2001, fps, false), true);
  }
});

test('quality selection uses persisted presets, explicit URLs, and safe recovery in order', async () => {
  const { resolveQualityProfile } = await import('../public/client/quality.js');
  const storage = memoryStorage();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    Object.defineProperty(globalThis, 'location', { value: { search: '' }, configurable: true });
    saveGraphicsSettings({ preset: 'high' }, storage);
    assert.equal(resolveQualityProfile().requested, 'high');
    globalThis.location.search = '?quality=balanced';
    assert.equal(resolveQualityProfile().id, 'balanced');
    globalThis.location.search = '?quality=__proto__';
    assert.equal(resolveQualityProfile().id, 'high');
    globalThis.location.search = '?safe=1';
    assert.equal(resolveQualityProfile().waterQuality, 'simple');
    assert.equal(resolveQualityProfile().loadModels, false);
    globalThis.location.search = '';
    saveGraphicsSettings({ preset: 'low' }, storage);
    assert.equal(resolveQualityProfile().label, 'SAFE');
    assert.equal(resolveQualityProfile().frameRate, 30);
  } finally {
    for (const [name, descriptor] of [['localStorage', previousStorage], ['location', previousLocation]]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('save-and-apply only navigates after storage succeeds', async () => {
  const module = await import('../public/client/graphics-settings.js');
  assert.equal(typeof module.commitGraphicsSettings, 'function');
  const values = new Map(), storage = { setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  let next;
  assert.equal(module.commitGraphicsSettings({ preset: 'balanced' }, {
    storage, href: 'https://example.test/?region=abc&quality=ultra#view', navigate: value => { next=value; },
  }), true);
  assert.equal(next, 'https://example.test/?region=abc#view');
  next=undefined;
  assert.equal(module.commitGraphicsSettings({}, {storage: {setItem() {throw Error('quota');}},
    href: 'https://example.test/', navigate: value => {next=value;}}), false);
  assert.equal(next, undefined);
});
