import test from 'node:test';
import assert from 'node:assert/strict';
const water = await import('../public/client/water-shading.js').catch(() => ({}));
const shader = () => ({ vertexShader: '#include <project_vertex>', fragmentShader:
  '#include <color_fragment>\n#include <normal_fragment_maps>\n#include <opaque_fragment>' });
test('water uses antialiased world-space ripples and grazing reflection without displacement or render passes', () => {
  assert.equal(typeof water.patchWaterShader, 'function');
  const s = shader(); water.patchWaterShader(s, 'ripples');
  assert.equal(s.vertexShader, '#include <project_vertex>');
  assert.match(s.fragmentShader, /fwidth/);
  assert.match(s.fragmentShader, /vMoyoWorld/);
  assert.match(s.fragmentShader, /moyoFresnel/);
  assert.match(s.fragmentShader, /moyoTime/);
  assert.doesNotMatch(s.fragmentShader, /sampler2D|transmission|texture2D/);
});
test('simple water omits procedural noise, waves and grazing highlight work', () => {
  assert.equal(typeof water.patchWaterShader, 'function');
  const s = shader(), original = s.fragmentShader;
  water.patchWaterShader(s, 'simple');
  assert.equal(s.fragmentShader, original);
});

test('water integration selects simple shading, chains existing hooks, and separates GPU cache keys', async () => {
  const { styleSurface } = await import('../public/client/surface-detail.js');
  let calls=0;
  const material = () => ({ isMeshStandardMaterial:true, isMeshPhysicalMaterial:true,
    userData:{}, color:{set(){}}, customProgramCacheKey:()=> 'base', onBeforeCompile() {calls++;} });
  const simple=material(), waves=material(), clock={value:0};
  styleSurface(simple,'water',clock,{waterQuality:'simple'});
  styleSurface(waves,'water',clock,{waterQuality:'ripples'});
  const s=shader(); s.uniforms={}; simple.onBeforeCompile(s);
  assert.equal(calls,1); assert.doesNotMatch(s.fragmentShader,/moyoTime|moyoFresnel/);
  assert.equal(simple.transmission,0); assert.equal(simple.clearcoat,0);
  const w=shader(); w.uniforms={}; waves.onBeforeCompile(w);
  assert.equal(w.uniforms.moyoTime,clock); assert.match(w.fragmentShader,/moyoFresnel/);
  assert.notEqual(simple.customProgramCacheKey(),waves.customProgramCacheKey());
  const first=waves.onBeforeCompile; styleSurface(waves,'water',clock);
  assert.equal(first,waves.onBeforeCompile);
});
