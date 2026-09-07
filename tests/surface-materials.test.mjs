import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
const url = new URL('../public/client/surface-materials.js', import.meta.url);
const feature = existsSync(url) ? await import(url) : {};
function api() {
  assert.equal(typeof feature.applySurfaceMaterial, 'function', 'world-space surface material feature is missing');
  assert.equal(typeof feature.createSurfaceUniforms, 'function');
  return feature;
}
function shader(material) {
  const source = material.isMeshPhysicalMaterial ? THREE.ShaderLib.physical : THREE.ShaderLib.standard;
  const result = { uniforms: {}, vertexShader: source.vertexShader, fragmentShader: source.fragmentShader };
  material.onBeforeCompile(result, {});
  return result;
}
test('surface shaders use world coordinates without changing welded vertices', () => {
  const { applySurfaceMaterial, createSurfaceUniforms } = api();
  const geometry = new THREE.PlaneGeometry(2, 2);
  const before = Array.from(geometry.attributes.position.array);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  applySurfaceMaterial(material, 'land', createSurfaceUniforms(), { normals: true });
  const compiled = shader(material);
  assert.match(compiled.vertexShader, /modelMatrix \* vec4\(transformed, 1\.0\)/);
  assert.doesNotMatch(compiled.vertexShader, /transformed\.[xyz]\s*[+*-]=/);
  assert.match(compiled.fragmentShader, /moyoNoise/);
  assert.match(compiled.fragmentShader, /moyoPerturbNormal/);
  assert.deepEqual(Array.from(geometry.attributes.position.array), before);
  assert.equal(material.map, null);
  geometry.dispose(); material.dispose();
});
test('all surfaces share animation uniforms and retain shadow and clipping chunks', () => {
  const { applySurfaceMaterial, createSurfaceUniforms } = api();
  const shared = createSurfaceUniforms();
  for (const kind of ['land', 'water']) {
    const material = new THREE.MeshStandardMaterial();
    applySurfaceMaterial(material, kind, shared, { normals: true });
    const compiled = shader(material);
    assert.equal(compiled.uniforms.uMoyoTime, shared.time);
    assert.match(compiled.fragmentShader, /#include <clipping_planes_fragment>/);
    assert.match(compiled.fragmentShader, /#include <lights_fragment_begin>/);
    shared.time.value = 19;
    assert.equal(compiled.uniforms.uMoyoTime.value, 19);
  }
});
test('surface patch is idempotent but a cloned material gets its own shader hook', () => {
  const { applySurfaceMaterial, createSurfaceUniforms } = api();
  const material = new THREE.MeshStandardMaterial();
  const shared = createSurfaceUniforms();
  applySurfaceMaterial(material, 'land', shared, { normals: true });
  const version = material.version;
  const hook = material.onBeforeCompile;
  applySurfaceMaterial(material, 'land', shared, { normals: true });
  assert.equal(material.version, version);
  assert.equal(material.onBeforeCompile, hook);
  const clone = material.clone();
  applySurfaceMaterial(clone, 'land', shared, { normals: true });
  assert.match(shader(clone).fragmentShader, /moyoNoise/);
});
test('program keys separate land, water and inexpensive no-bump profiles', () => {
  const { applySurfaceMaterial, createSurfaceUniforms } = api();
  const keys = [];
  for (const [kind, normals] of [['land', true], ['water', true], ['land', false]]) {
    const material = new THREE.MeshStandardMaterial();
    applySurfaceMaterial(material, kind, createSurfaceUniforms(), { normals });
    keys.push(material.customProgramCacheKey());
    if (!normals) assert.doesNotMatch(shader(material).fragmentShader, /normal = moyoPerturbNormal/);
  }
  assert.equal(new Set(keys).size, 3);
});
test('previous shader customization still runs and material clipping stays intact', () => {
  const { applySurfaceMaterial, createSurfaceUniforms } = api();
  const material = new THREE.MeshStandardMaterial();
  material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 4)];
  const planes = material.clippingPlanes;
  let called = 0;
  material.onBeforeCompile = (value) => { called++; value.uniforms.previous = { value: 3 }; };
  material.customProgramCacheKey = () => 'previous-key';
  applySurfaceMaterial(material, 'land', createSurfaceUniforms(), { normals: true });
  assert.equal(shader(material).uniforms.previous.value, 3);
  assert.equal(called, 1);
  assert.equal(material.clippingPlanes, planes);
  assert.match(material.customProgramCacheKey(), /previous-key/);
});
test('central and neighboring water receive identical opaque depth-safe PBR settings', () => {
  const { applySurfaceMaterial, createSurfaceUniforms } = api();
  const materials = [new THREE.MeshPhysicalMaterial(), new THREE.MeshStandardMaterial()];
  for (const material of materials) {
    applySurfaceMaterial(material, 'water', createSurfaceUniforms(), { normals: true });
    assert.equal(material.userData.moyoSurfaceKind, 'water');
    assert.equal(material.userData.moyoDecayStyled, true);
    assert.equal(material.transparent, false);
    assert.equal(material.depthWrite, true);
    assert.ok(material.roughness < 0.4);
    assert.match(shader(material).fragmentShader, /moyoWaveHeight/);
  }
  assert.equal(materials[0].color.getHex(), materials[1].color.getHex());
});
