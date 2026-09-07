import { WorldView } from './world-view.js';
import { NOISE_GLSL, styleSurface } from './surface-detail.js';
import { buildGroundCover, disposeGroundCover, groundCoverSignature } from './ground-cover.js';

const CLOUD_SHADER = `
varying vec3 vDirection;
uniform vec3 zenithColor, horizonColor, groundColor, sunColor;
uniform float moyoTime;
${NOISE_GLSL}
void main() {
  vec3 dir=normalize(vDirection);
  float up=clamp(dir.y,-1.0,1.0);
  vec3 color=mix(horizonColor,zenithColor,pow(max(up,0.0),0.55));
  color=mix(color,groundColor,(1.0-smoothstep(-0.32,0.05,up))*0.62);
  vec2 p=dir.xz/max(up+0.22,0.15)*1.5 + vec2(moyoTime*0.004,moyoTime*0.0015);
  float cloud=moyoNoise(p)*0.57+moyoNoise(p*2.07)*0.28+moyoNoise(p*4.11)*0.15;
  float cover=smoothstep(0.35,0.72,cloud)*smoothstep(0.015,0.22,up);
  vec3 cloudColor=mix(zenithColor*0.68,horizonColor*1.16,smoothstep(0.42,0.72,cloud));
  color=mix(color,cloudColor,cover*0.88);
  color+=sunColor*exp(-abs(up)*8.0)*0.045;
  gl_FragColor=vec4(color,1.0);
  #include <colorspace_fragment>
}
`;

export function updateAtmosphere(view, time) {
  if (!Object.hasOwn(view,'moyoAtmosphere')) {
    const clock={value:0};
    view.moyoAtmosphere={clock, start:time, nextSweep:0, signature:null, cover:null,
      motion:globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'),stats:{grass:0,extraDraws:0}};
    const material=view.sky?.material;
    if(material?.isShaderMaterial) {
      material.uniforms.moyoTime=clock;
      material.fragmentShader=CLOUD_SHADER;
      material.needsUpdate=true;
    }
    view.moyoCoverDirty=true;
  }
  const state=view.moyoAtmosphere;
  state.clock.value=state.motion?.matches?0:Math.max(0,time-state.start)/1000;
  // Direct surfaces can change on a region transition. The preview hierarchy is
  // small and swept infrequently; no full scene traversal or allocations/frame.
  styleSurface(view.terrainMesh?.material,'land',state.clock);
  styleSurface(view.waterMesh?.material,'water',state.clock);
  if(time>=state.nextSweep) {
    state.nextSweep=time+800;
    view.worldRoot?.getObjectByName('neighbor-region-preview')?.traverse(object=>{
      if(object.name==='neighbor-hex-land')styleSurface(object.material,'land',state.clock);
      if(object.name==='neighbor-hex-water')styleSurface(object.material,'water',state.clock);
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
