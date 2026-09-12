import * as THREE from 'three';
import { WorldView } from './world-view.js';
import { NOISE_GLSL, styleSurface } from './surface-detail.js';
import { buildGroundCover, disposeGroundCover, groundCoverSignature, groundCoverBudget } from './ground-cover.js';

// The same absolute region frame is reused after the camera recenters on a
// neighbor. Metadata is already delivered by the live window; no extra requests.
const regionOrigins = new Map();
export function primeAtmosphereTopology(payload) {
  const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
  const valid = chunks.filter(chunk => typeof chunk?.regionId === 'string'
    && Number.isFinite(chunk.hexOrigin?.x) && Number.isFinite(chunk.hexOrigin?.y));
  if (!valid.length) return;
  regionOrigins.clear();
  for (const chunk of valid) regionOrigins.set(chunk.regionId, chunk.hexOrigin);
}
globalThis.addEventListener?.('moyo:neighbor-topology', event => primeAtmosphereTopology(event?.detail?.payload));

const SUN_SHADER = `
  float sunDot = max(dot(dir, normalize(sunDirection)), 0.0);
  float sunEdge = max(fwidth(sunDot), 0.000002);
  // Approximately half a degree across: a small distant sun, never a nearby orb.
  float sunDisc = smoothstep(0.999992 - sunEdge, 0.999992 + sunEdge, sunDot);
  float sunHalo = pow(sunDot, 24.0) * 0.12 + pow(sunDot, 160.0) * 0.07;
`;
const SIMPLE_SKY_SHADER = `
varying vec3 vDirection;
uniform vec3 zenithColor, horizonColor, groundColor, sunColor, sunDirection;
void main() {
  vec3 dir=normalize(vDirection);
  float up=clamp(dir.y,-1.0,1.0);
  vec3 color=mix(horizonColor,zenithColor,pow(max(up,0.0),0.55));
  color=mix(color,groundColor,(1.0-smoothstep(-0.32,0.05,up))*0.62);
  ${SUN_SHADER}
  color += sunColor * (sunHalo + sunDisc * 0.82) * smoothstep(-0.015,0.03,up);
  gl_FragColor=vec4(color,1.0);
  #include <colorspace_fragment>
}
`;
const CLOUD_SHADER = `
varying vec3 vDirection;
uniform vec3 zenithColor, horizonColor, groundColor, sunColor, sunDirection;
uniform float moyoTime;
${NOISE_GLSL}
void main() {
  vec3 dir=normalize(vDirection);
  float up=clamp(dir.y,-1.0,1.0);
  vec3 color=mix(horizonColor,zenithColor,pow(max(up,0.0),0.55));
  color=mix(color,groundColor,(1.0-smoothstep(-0.32,0.05,up))*0.62);
  ${SUN_SHADER}
  vec2 p=dir.xz/max(up+0.22,0.15)*1.5 + vec2(moyoTime*0.004,moyoTime*0.0015);
  float cloud=moyoNoise(p)*0.57+moyoNoise(p*2.07)*0.28+moyoNoise(p*4.11)*0.15;
  float cover=smoothstep(0.39,0.72,cloud)*smoothstep(0.015,0.22,up);
  float billow=smoothstep(0.43,0.72,cloud);
  vec3 cloudColor=mix(zenithColor*0.62,horizonColor*1.15,billow);
  float silver=smoothstep(0.1,0.45,cover)*(1.0-smoothstep(0.50,0.92,cover))*pow(sunDot,12.0);
  cloudColor += sunColor * silver * 0.42;
  color=mix(color,cloudColor,cover*0.88);
  // Dense cloud dims the disc and halo together, keeping their direction legible.
  float sunlight=1.0-cover*0.94;
  color += sunColor * (sunHalo + sunDisc * 0.82) * sunlight * smoothstep(-0.015,0.03,up);
  gl_FragColor=vec4(color,1.0);
  #include <colorspace_fragment>
}
`;

function updateSky(view, state) {
  const material=view.sky?.material;
  if (!material?.isShaderMaterial) return;
  if (view.sun?.getWorldPosition && view.sun.target?.getWorldPosition) {
    view.sun.getWorldPosition(state.sunDirection.value);
    view.sun.target.getWorldPosition(state.sunTarget);
    state.sunDirection.value.sub(state.sunTarget).normalize();
  }
  const simple=view.quality?.label==='SAFE' || ['safe','low','light'].includes(view.quality?.requested);
  const shader=simple?SIMPLE_SKY_SHADER:CLOUD_SHADER;
  if (state.skyMaterial!==material || material.fragmentShader!==shader) {
    state.skyMaterial=material;
    material.uniforms.moyoTime=state.clock;
    material.uniforms.sunDirection=state.sunDirection;
    material.fragmentShader=shader;
    material.needsUpdate=true;
  }
}

export function updateAtmosphere(view, time) {
  if (!Object.hasOwn(view,'moyoAtmosphere')) {
    const clock={value:0};
    view.moyoAtmosphere={clock, worldOrigin:{value:new THREE.Vector2()},
      sunDirection:{value:new THREE.Vector3(-20,29,11).normalize()},sunTarget:new THREE.Vector3(),
      start:time, nextSweep:0, signature:null, cover:null,
      motion:globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'),stats:{grass:0,extraDraws:0}};
    view.moyoAtmosphere.surfaceOptions={quality:view.quality,worldOrigin:view.moyoAtmosphere.worldOrigin};
    view.moyoCoverDirty=true;
  }
  const state=view.moyoAtmosphere;
  const origin=regionOrigins.get(view.state?.regionId);
  state.worldOrigin.value.set(origin?.x??0,origin?.y??0);
  updateSky(view,state);
  const surfaceOptions=state.surfaceOptions;
  surfaceOptions.quality=view.quality;
  const coverBudget=groundCoverBudget(view.quality);
  if(state.coverBudget!==coverBudget)view.moyoCoverDirty=true;
  state.clock.value=state.motion?.matches?0:Math.max(0,time-state.start)/1000;
  // Direct surfaces can change on a region transition. The preview hierarchy is
  // small and swept infrequently; no full scene traversal or allocations/frame.
  styleSurface(view.terrainMesh?.material,'land',state.clock,surfaceOptions);
  styleSurface(view.waterMesh?.material,'water',state.clock,surfaceOptions);
  if(time>=state.nextSweep) {
    state.nextSweep=time+800;
    view.worldRoot?.getObjectByName('neighbor-region-preview')?.traverse(object=>{
      if(object.name==='neighbor-hex-land')styleSurface(object.material,'land',state.clock,surfaceOptions);
      if(object.name==='neighbor-hex-water')styleSurface(object.material,'water',state.clock,surfaceOptions);
    });
  }
  const geometry=view.terrainMesh?.geometry;
  const positionVersion=geometry?.getAttribute('position')?.version;
  if(state.geometry!==geometry || state.positionVersion!==positionVersion)view.moyoCoverDirty=true;
  if (time-state.start<650 || !view.terrainMesh || !view.state || !view.moyoCoverDirty) return;
  view.moyoCoverDirty=false;
  const signature=groundCoverSignature(view);
  if(signature===state.signature)return;
  disposeGroundCover(state.cover);
  state.cover=buildGroundCover(view,state.clock);
  state.signature=signature;
  state.coverBudget=coverBudget;
  state.geometry=geometry;
  state.positionVersion=positionVersion;
  view.worldRoot.add(state.cover);
  state.stats={grass:state.cover.getObjectByName('MoyoDryGrass')?.count??0,extraDraws:state.cover.children.length};
}

const previousUpdateCamera=WorldView.prototype.updateCamera;
WorldView.prototype.updateCamera=function updateCameraWithAtmosphere() {
  previousUpdateCamera.call(this);
  updateAtmosphere(this,performance.now());
};
const previousSetState=WorldView.prototype.setState;
WorldView.prototype.setState=function setStateWithGroundCover(...args) {
  previousSetState.apply(this,args);
  this.moyoCoverDirty=true;
};
