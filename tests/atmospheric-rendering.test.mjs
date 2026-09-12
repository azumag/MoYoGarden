import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createInitialWorld } from '../dist-ts/src/world.js';
import { WorldView } from '../public/client/world-view.js';
import '../public/client/hex-tile-rendering.js';
const surface = await import('../public/client/surface-detail.js').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
const cover = await import('../public/client/ground-cover.js').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});

function fixture(quality = { id: 'high', detailDensity: 0.86 }) {
  const view = Object.create(WorldView.prototype);
  view.quality = quality;
  view.worldRoot = new THREE.Group();
  view.surfaceHeightMap = new Map();
  view.state = createInitialWorld({ seed: 424242, width: 40, height: 24 });
  view.buildTerrain(view.state);
  return view;
}

test('surface sampler interpolates real triangle heights, never extrapolates beyond terrain', () => {
  assert.equal(typeof surface.createSurfaceSampler, 'function');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,2,2, 2,0,0], 3));
  geometry.setIndex([0,1,2]);
  const sample = surface.createSurfaceSampler(geometry);
  assert.equal(sample(0.5, 0.5), 0.5);
  assert.equal(sample(0,0), 0);
  assert.equal(sample(1.9,1.9), undefined);
  assert.equal(sample(NaN,0), undefined);
});

test('surface shader uses a shared world coordinate frame without moving boundary vertices', () => {
  assert.equal(typeof surface.styleSurface, 'function');
  const material = new THREE.MeshStandardMaterial();
  const clock = { value: 0 };
  surface.styleSurface(material, 'land', clock);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /modelMatrix/);
  assert.match(shader.fragmentShader, /vMoyoWorld/);
  assert.doesNotMatch(shader.vertexShader, /transformed\.[xyz]\s*[+*\-]?=/);
  assert.equal(shader.uniforms.moyoTime, clock);
  assert.match(shader.fragmentShader, /moyoNoise/);
});

test('surface hooks chain once, but a cloned material receives its own hook', () => {
  assert.equal(typeof surface.styleSurface, 'function');
  const material = new THREE.MeshStandardMaterial();
  let calls=0;
  material.onBeforeCompile = () => { calls++; };
  surface.styleSurface(material, 'land', { value: 0 });
  const first = material.onBeforeCompile;
  surface.styleSurface(material, 'land', { value: 0 });
  assert.equal(material.onBeforeCompile, first);
  const clone = material.clone();
  surface.styleSurface(clone, 'water', { value: 1 });
  assert.notEqual(clone.onBeforeCompile, THREE.Material.prototype.onBeforeCompile);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader);
  assert.equal(calls,1);
  assert.notEqual(material.customProgramCacheKey(), clone.customProgramCacheKey());
});

test('water ripples alter shading, not geometry or transparency each CPU frame', () => {
  assert.equal(typeof surface.styleSurface, 'function');
  const material = new THREE.MeshPhysicalMaterial({ transparent: true });
  surface.styleSurface(material, 'water', { value: 0 });
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /moyoTime/);
  assert.match(shader.fragmentShader, /normal = normalize/);
  assert.doesNotMatch(shader.vertexShader, /transformed\.[xyz]\s*[+*\-]?=/);
  assert.equal(material.userData.moyoSurfaceKind, 'water');
});

test('ground-cover density is bounded and safe mode adds no vegetation', () => {
  assert.equal(typeof cover.groundCoverBudget, 'function');
  assert.equal(cover.groundCoverBudget({id:'balanced', label:'SAFE'}), 0);
  assert.equal(cover.groundCoverBudget({id:'balanced', requested:'safe'}), 0);
  assert.equal(cover.groundCoverBudget({id:'balanced', requested:'low'}), 0);
  assert.ok(cover.groundCoverBudget({id:'ultra'}) > cover.groundCoverBudget({id:'high'}));
  assert.ok(cover.groundCoverBudget({id:'high'}) > cover.groundCoverBudget({id:'balanced'}));
  assert.ok(cover.groundCoverBudget({id:'ultra'}) <= 3000);
});

test('ground cover is deterministic, bounded, on the rendered surface, and adds at most two draws', () => {
  assert.equal(typeof cover.buildGroundCover, 'function');
  const view = fixture();
  const before = JSON.stringify(view.state);
  const a = cover.buildGroundCover(view, {value:0});
  const b = cover.buildGroundCover(view, {value:0});
  const grass = a.getObjectByName('MoyoDryGrass');
  assert.ok(grass?.isInstancedMesh);
  assert.ok(grass.count > 100 && grass.count <= cover.groundCoverBudget(view.quality));
  assert.ok(a.children.length <= 2);
  assert.deepEqual(grass.instanceMatrix.array, b.getObjectByName('MoyoDryGrass').instanceMatrix.array);
  const sample = surface.createSurfaceSampler(view.terrainMesh.geometry);
  const matrix = new THREE.Matrix4();
  for(let i=0;i<grass.count;i++) {
    grass.getMatrixAt(i,matrix);
    const [x,y,z] = matrix.elements.slice(12,15);
    const height = sample(x,z);
    assert.ok(Number.isFinite(height));
    assert.ok(Math.abs(y-height) < 0.025);
    assert.ok(height > -0.1, 'grass must not grow underwater');
  }
  assert.equal(JSON.stringify(view.state), before);
  cover.disposeGroundCover(a); cover.disposeGroundCover(b);
});

test('cover disposal releases owned GPU resources and never disposes terrain', () => {
  assert.equal(typeof cover.disposeGroundCover, 'function');
  const view = fixture();
  const group = cover.buildGroundCover(view, {value:0});
  view.worldRoot.add(group);
  let disposed = 0, terrainDisposed = false;
  group.traverse(o => {
    o.geometry?.addEventListener('dispose', () => disposed++);
    o.material?.addEventListener('dispose', () => disposed++);
  });
  view.terrainMesh.geometry.addEventListener('dispose', () => { terrainDisposed=true; });
  cover.disposeGroundCover(group);
  assert.ok(disposed >= 2);
  assert.equal(terrainDisposed,false);
  assert.equal(group.parent,null);
});

const atmosphere = await import('../public/client/atmosphere.js').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
function atmosphereFixture(quality) {
  const view=fixture(quality);
  view.scene=new THREE.Scene(); view.scene.add(view.worldRoot);
  view.sky=new THREE.Mesh(new THREE.SphereGeometry(1),new THREE.ShaderMaterial({
    uniforms:{zenithColor:{value:new THREE.Color()},horizonColor:{value:new THREE.Color()},
      groundColor:{value:new THREE.Color()},sunColor:{value:new THREE.Color()}}
  }));
  return view;
}

test('atmosphere defers cover, reuses it on ticks, and disposes on a terrain switch',()=>{
  assert.equal(typeof atmosphere.updateAtmosphere,'function');
  const view=atmosphereFixture();
  atmosphere.updateAtmosphere(view,0);
  assert.equal(view.moyoAtmosphere.cover,null);
  atmosphere.updateAtmosphere(view,1000);
  const group=view.moyoAtmosphere.cover;
  assert.ok(group?.children.length>0);
  view.moyoCoverDirty=true;view.state.revision++;
  atmosphere.updateAtmosphere(view,2000);
  assert.equal(view.moyoAtmosphere.cover,group);
  view.buildTerrain(view.state);view.moyoCoverDirty=true;
  atmosphere.updateAtmosphere(view,3000);
  assert.notEqual(view.moyoAtmosphere.cover,group);
  assert.equal(group.parent,null);
});

test('atmosphere styles late neighbor surfaces without adding objects to the outer ring',()=>{
  assert.equal(typeof atmosphere.updateAtmosphere,'function');
  const view=atmosphereFixture();
  atmosphere.updateAtmosphere(view,0);
  const preview=new THREE.Group();preview.name='neighbor-region-preview';
  const terrain=new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshStandardMaterial());
  terrain.name='neighbor-hex-land';
  preview.add(terrain);view.worldRoot.add(preview);
  atmosphere.updateAtmosphere(view,1000);
  assert.equal(terrain.material.userData.moyoSurfaceKind,'land');
  assert.equal(preview.children.length,1);
  assert.equal(view.terrainMesh.material.customProgramCacheKey(),terrain.material.customProgramCacheKey());
});

test('reduced motion freezes the shared clock without forcing a low-detail renderer',()=>{
  assert.equal(typeof atmosphere.updateAtmosphere,'function');
  const previous=globalThis.matchMedia;
  globalThis.matchMedia=()=>({matches:true});
  try {
    const view=atmosphereFixture({id:'high'});
    atmosphere.updateAtmosphere(view,1000);atmosphere.updateAtmosphere(view,4000);
    assert.equal(view.moyoAtmosphere.clock.value,0);
    assert.ok(view.moyoAtmosphere.cover.children.length>0);
  } finally { if(previous)globalThis.matchMedia=previous;else delete globalThis.matchMedia; }
});

test('authored foliage is earthy olive rather than cyan metal, while bark stays brown',()=>{
  const view=fixture();
  const leaves=new THREE.MeshStandardMaterial({color:0x2aceac,metalness:1});leaves.name='leafsGreen';
  const bark=new THREE.MeshStandardMaterial({color:0xe28257,metalness:1});bark.name='woodBark';
  const tree=new THREE.Group();tree.add(new THREE.Mesh(new THREE.BoxGeometry(),[leaves,bark]));
  view.naturalizeModel(tree,{x:19,y:11},'wood');
  const hsl={};leaves.color.getHSL(hsl);
  assert.ok(hsl.h>=0.12 && hsl.h<0.33);
  assert.equal(leaves.metalness,0);assert.equal(bark.metalness,0);
  assert.ok(bark.color.r>bark.color.g && bark.color.g>bark.color.b);
  assert.equal(leaves.userData.moyoDecayStyled,true);
});

test('late seam welding resamples decorations when terrain vertices change in place',()=>{
  const view=atmosphereFixture();
  atmosphere.updateAtmosphere(view,0);atmosphere.updateAtmosphere(view,1000);
  const before=view.moyoAtmosphere.cover;
  const position=view.terrainMesh.geometry.getAttribute('position');
  for(let i=0;i<position.count;i++)position.setY(i,position.getY(i)+0.05);
  position.needsUpdate=true;
  atmosphere.updateAtmosphere(view,2000);
  assert.notEqual(view.moyoAtmosphere.cover,before,'cover must follow async seam welding');
  assert.equal(before.parent,null);
  const sample=surface.createSurfaceSampler(view.terrainMesh.geometry);
  const grass=view.moyoAtmosphere.cover.getObjectByName('MoyoDryGrass');
  const matrix=new THREE.Matrix4();
  for(let i=0;i<grass.count;i++) {
    grass.getMatrixAt(i,matrix);
    const [x,y,z]=matrix.elements.slice(12,15);
    assert.ok(Math.abs(y-sample(x,z))<0.025);
  }
});

test('cloud sky restores a small antialiased sun aligned with the actual world-space light, including sky replacement',()=>{
  const view=atmosphereFixture();
  view.sun=new THREE.DirectionalLight();
  const parent=new THREE.Group();parent.position.set(5,3,-2);
  parent.add(view.sun);view.scene.add(parent,view.sun.target);
  view.sun.position.set(-8,9,4);view.sun.target.position.set(2,0,1);
  atmosphere.updateAtmosphere(view,0);
  const expected=new THREE.Vector3(-3,12,2).sub(view.sun.target.position).normalize();
  assert.ok(view.sky.material.uniforms.sunDirection.value.distanceTo(expected)<1e-12);
  assert.match(view.sky.material.fragmentShader,/sunDisc = smoothstep\(0\.999992/);
  assert.match(view.sky.material.fragmentShader,/fwidth\(sunDot\)/);
  assert.match(view.sky.material.fragmentShader,/sunlight=1\.0-cover\*0\.94/);
  assert.match(view.sky.material.fragmentShader,/silver/);
  const clock=view.moyoAtmosphere.clock;
  view.sky.material=view.sky.material.clone();view.sky.material.fragmentShader='replacement sky';
  view.sun.position.set(6,8,10);
  atmosphere.updateAtmosphere(view,1000);
  assert.equal(view.sky.material.uniforms.moyoTime,clock);
  assert.equal(view.sky.material.uniforms.sunDirection,view.moyoAtmosphere.sunDirection);
  assert.match(view.sky.material.fragmentShader,/sunDisc/);
  assert.ok(view.sky.material.uniforms.sunDirection.value.distanceTo(new THREE.Vector3(9,11,7).normalize())<1e-12);
});

test('ground, water and instanced wind retain the same absolute phase through a region handoff',()=>{
  atmosphere.primeAtmosphereTopology({chunks:[
    {regionId:'phase-west',hexOrigin:{x:20,y:30}},
    {regionId:'phase-east',hexOrigin:{x:48,y:37}},
  ]});
  const view=atmosphereFixture();view.state.regionId='phase-west';
  atmosphere.updateAtmosphere(view,0);atmosphere.updateAtmosphere(view,1000);
  const compile=material=>{
    const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
    material.onBeforeCompile(shader);return shader;
  };
  const land=compile(view.terrainMesh.material);
  const grass=compile(view.moyoAtmosphere.cover.getObjectByName('MoyoDryGrass').material);
  const water=new THREE.MeshPhysicalMaterial();
  surface.styleSurface(water,'water',view.moyoAtmosphere.clock,{waterQuality:'ripples',worldOrigin:view.moyoAtmosphere.worldOrigin});
  const waves=compile(water);
  for(const shader of [land,grass,waves]) {
    assert.equal(shader.uniforms.moyoWorldOrigin,view.moyoAtmosphere.worldOrigin);
    assert.equal(shader.uniforms.moyoTime,view.moyoAtmosphere.clock);
  }
  assert.match(land.vertexShader,/vMoyoWorld.xz \+= moyoWorldOrigin/);
  assert.match(grass.vertexShader,/modelMatrix \* instanceMatrix/);
  assert.match(grass.vertexShader,/moyoGrassWorld\[3\].xz \+ moyoWorldOrigin/);
  // The rendered point x=9,z=4 in west becomes x=-19,z=-3 after camera rebasing.
  const absoluteBefore=new THREE.Vector2(9,4).add(land.uniforms.moyoWorldOrigin.value);
  const originalClock=view.moyoAtmosphere.clock;
  view.state={...view.state,regionId:'phase-east'};
  atmosphere.updateAtmosphere(view,1500);
  const absoluteAfter=new THREE.Vector2(-19,-3).add(land.uniforms.moyoWorldOrigin.value);
  assert.ok(absoluteBefore.distanceTo(absoluteAfter)<1e-12);
  assert.equal(view.moyoAtmosphere.clock,originalClock);
  assert.equal(view.moyoAtmosphere.clock.value,1.5);
  // New snapshot geometry binds to the same live uniform, as do late neighbor clones.
  view.buildTerrain(view.state);atmosphere.updateAtmosphere(view,2000);
  assert.equal(compile(view.terrainMesh.material).uniforms.moyoWorldOrigin,land.uniforms.moyoWorldOrigin);
  const clone=view.terrainMesh.material.clone();surface.styleSurface(clone,'land',originalClock,view.moyoAtmosphere.surfaceOptions);
  assert.equal(compile(clone).uniforms.moyoWorldOrigin,land.uniforms.moyoWorldOrigin);
  cover.disposeGroundCover(view.moyoAtmosphere.cover);water.dispose();clone.dispose();
});

test('safe quality omits cloud noise, terrain relief, water waves and vegetation',()=>{
  const view=atmosphereFixture({id:'balanced',label:'SAFE',requested:'low',waterQuality:'simple',detailDensity:0});
  atmosphere.updateAtmosphere(view,0);atmosphere.updateAtmosphere(view,1000);
  assert.doesNotMatch(view.sky.material.fragmentShader,/moyoNoise|moyoTime/);
  assert.match(view.sky.material.fragmentShader,/sunDirection/);
  const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
  view.terrainMesh.material.onBeforeCompile(shader);
  assert.doesNotMatch(shader.fragmentShader,/moyoNoise|moyoRelief/);
  assert.equal(view.moyoAtmosphere.cover.children.length,0);
});

test('changing vegetation density releases the old GPU cover and keeps the new budget in its signature',()=>{
  const view=atmosphereFixture();
  atmosphere.updateAtmosphere(view,0);atmosphere.updateAtmosphere(view,1000);
  const old=view.moyoAtmosphere.cover, grass=old.getObjectByName('MoyoDryGrass');
  let geometryDisposed=0, materialDisposed=0;
  grass.geometry.addEventListener('dispose',()=>geometryDisposed++);
  grass.material.addEventListener('dispose',()=>materialDisposed++);
  const oldSignature=cover.groundCoverSignature(view);
  view.quality={...view.quality,detailDensity:0};
  assert.notEqual(cover.groundCoverSignature(view),oldSignature);
  atmosphere.updateAtmosphere(view,1100);
  assert.equal(old.parent,null);
  assert.equal(geometryDisposed,1);assert.equal(materialDisposed,1);
  assert.equal(view.moyoAtmosphere.cover.children.length,0);
  atmosphere.updateAtmosphere(view,1200);
  assert.equal(geometryDisposed,1);assert.equal(materialDisposed,1);
});
