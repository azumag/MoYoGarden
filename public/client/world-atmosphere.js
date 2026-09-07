import { WorldView } from "./world-view.js";
import { disposeObject } from "./shared.js";
import { createGroundCover } from "./ground-cover.js";
import { applySurfaceMaterial, createSurfaceUniforms, SURFACE_NOISE_GLSL } from "./surface-materials.js";

const SURFACES = new Map([
  ["hex-cell-terrain", "land"], ["neighbor-hex-land", "land"],
  ["hex-cell-water", "water"], ["neighbor-hex-water", "water"],
]);
export function atmosphereTime(time, reducedMotion, label) {
  return reducedMotion || label === "SAFE" ? 0 : Math.max(0, Number(time) || 0) / 1000;
}
function uniformsFor(view) {
  if (!Object.hasOwn(view, "moyoAtmosphereUniforms")) view.moyoAtmosphereUniforms = createSurfaceUniforms();
  return view.moyoAtmosphereUniforms;
}
export function refreshAtmosphereSurfaces(view) {
  const uniforms = uniformsFor(view);
  const normals = view.quality.label !== "SAFE" && ["high", "ultra"].includes(view.quality.id);
  let anchorFound = false;
  view.worldRoot?.traverse((object) => {
    const origin = object.userData?.moyoHexOrigin;
    if (!anchorFound && Number.isFinite(origin?.x) && Number.isFinite(origin?.y)) {
      uniforms.origin.value.set(origin.x - object.position.x, origin.y - object.position.z);
      anchorFound = true;
    }
    const kind = SURFACES.get(object.name);
    if (kind) applySurfaceMaterial(object.material, kind, uniforms, { normals });
  });
  if (!view.terrainMesh || !view.detailRoot || !view.state?.tiles) return;
  const geometry = view.terrainMesh.geometry;
  const occupied = (view.state.structures ?? []).map(({ position }) => `${position.x}:${position.y}`).sort().join(",");
  const coverKey = `${geometry.uuid}:${geometry.attributes.position.version}:${occupied}`;
  if (view.moyoGroundCoverKey === coverKey) return;
  disposeObject(view.detailRoot.getObjectByName("moyo-ground-cover"));
  const cover = createGroundCover(view.terrainMesh, view.state, view.quality, uniforms);
  if (cover) view.detailRoot.add(cover);
  view.moyoGroundCoverKey = coverKey;
}

function installLayeredSky(view) {
  const sky = view.sky, material = sky?.material;
  if (!material?.isShaderMaterial || !sky.userData.moyoOrbFixApplied || sky.userData.moyoAtmosphereSky) return;
  sky.userData.moyoAtmosphereSky = true;
  material.uniforms.uMoyoTime = uniformsFor(view).time;
  material.uniforms.zenithColor.value.set(0x3e505a);
  material.uniforms.horizonColor.value.set(0x8b9187);
  material.uniforms.groundColor.value.set(0x565e54);
  material.fragmentShader = `
    varying vec3 vDirection;
    uniform vec3 zenithColor, horizonColor, groundColor, sunColor;
    uniform float uMoyoTime;
    ${SURFACE_NOISE_GLSL}
    void main() {
      vec3 dir = normalize(vDirection);
      float up = clamp(dir.y, -1.0, 1.0);
      vec3 color = mix(horizonColor, zenithColor, pow(max(up, 0.0), 0.5));
      color = mix(color, groundColor, 1.0 - smoothstep(-0.4, 0.015, up));
      ${view.quality.label === "SAFE" ? "" : `
      if (up > -0.025) {
        vec2 p = dir.xz / max(0.16, dir.y + 0.32);
        p += vec2(uMoyoTime * 0.006, uMoyoTime * 0.002);
        float broad = moyoNoise(p * 1.7);
        float fine = moyoNoise(p * 4.8 + broad * 1.3);
        float cloud = smoothstep(0.39, 0.78, broad * 0.72 + fine * 0.28);
        cloud *= smoothstep(-0.025, 0.12, up);
        color = mix(color, horizonColor * (0.58 + fine * 0.24), cloud * 0.85);
        color += sunColor * smoothstep(0.5, 0.65, broad) * (1.0 - cloud) * 0.035;
      }`}
      color += sunColor * exp(-abs(up) * 9.0) * 0.025;
      gl_FragColor = vec4(color, 1.0);
      #include <colorspace_fragment>
    }
  `;
  material.needsUpdate = true;
}
const baseMarkShadowsDirty = WorldView.prototype.markShadowsDirty;
WorldView.prototype.markShadowsDirty = function markShadowsDirtyWithAtmosphere() {
  baseMarkShadowsDirty.call(this);
  refreshAtmosphereSurfaces(this);
};
const baseUpdateCamera = WorldView.prototype.updateCamera;
WorldView.prototype.updateCamera = function updateCameraWithAtmosphere() {
  baseUpdateCamera.call(this);
  const uniforms = uniformsFor(this);
  this.moyoMotionPreference ??= globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false };
  uniforms.time.value = atmosphereTime(this.lastFrame, this.moyoMotionPreference.matches, this.quality.label);
  installLayeredSky(this);
  // Async topology conversion can finish outside the markShadowsDirty wrapper.
  // Never scan every model on every animation frame.
  const now = performance.now();
  if (now >= (this.moyoNextAtmosphereSweep ?? 0)) {
    this.moyoNextAtmosphereSweep = now + 1000;
    refreshAtmosphereSurfaces(this);
  }
};
