import * as THREE from "three";

// Weak ownership: replacing regions cannot retain disposed materials.
const installed = new WeakMap();
export function createSurfaceUniforms() {
  return { time: { value: 0 }, origin: { value: new THREE.Vector2() } };
}

export const SURFACE_NOISE_GLSL = `
float moyoHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float moyoNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(moyoHash(i), moyoHash(i + vec2(1.0, 0.0)), u.x),
             mix(moyoHash(i + vec2(0.0, 1.0)), moyoHash(i + 1.0), u.x), u.y);
}
`;
const NORMAL_GLSL = `
vec3 moyoPerturbNormal(vec3 n, float h) {
  vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return abs(det) < 0.00000001 ? n : normalize(abs(det) * n - grad);
}
`;
const WAVE_GLSL = `
float moyoWaveHeight(vec2 p, float t) {
  return sin(dot(p, vec2(2.6, 1.4)) + t * 0.9) * 0.025
       + sin(dot(p, vec2(-3.8, 5.2)) - t * 1.25) * 0.014
       + sin(dot(p, vec2(9.2, 7.7)) + t * 1.6) * 0.005;
}
`;

/** Render-only detail: never displace welded vertices or change picking. */
export function applySurfaceMaterial(material, kind, uniforms, { normals = true } = {}) {
  if (!material?.isMeshStandardMaterial || !["land", "water"].includes(kind)) return material;
  const previous = installed.get(material);
  if (previous?.kind === kind && previous.normals === normals && previous.uniforms === uniforms) return material;
  const baseCompile = previous?.baseCompile ?? material.onBeforeCompile;
  const baseKey = previous?.baseKey ?? material.customProgramCacheKey.call(material);
  installed.set(material, { kind, normals, uniforms, baseCompile, baseKey });
  material.userData.moyoSurfaceKind = kind;
  if (kind === "water") {
    material.userData.moyoDecayStyled = true;
    material.color.set(0x60877a);
    material.roughness = 0.28;
    material.metalness = 0.08;
    material.envMapIntensity = 0.62;
    material.transparent = false;
    material.opacity = 1;
    material.depthWrite = true;
    if (material.isMeshPhysicalMaterial) {
      material.clearcoat = 0;
      material.transmission = 0;
    }
  }
  material.onBeforeCompile = function compileSurface(shader, renderer) {
    baseCompile.call(this, shader, renderer);
    shader.uniforms.uMoyoTime = uniforms.time;
    shader.uniforms.uMoyoOrigin = uniforms.origin;
    shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>
      varying vec3 vMoyoSurfacePosition;`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
      vMoyoSurfacePosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
      varying vec3 vMoyoSurfacePosition;
      uniform float uMoyoTime;
      uniform vec2 uMoyoOrigin;
      ${SURFACE_NOISE_GLSL}
      ${normals ? NORMAL_GLSL : ""}
      ${kind === "water" ? WAVE_GLSL : ""}`);
    if (kind === "land") {
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <color_fragment>", `#include <color_fragment>
          vec2 moyoP = vMoyoSurfacePosition.xz + uMoyoOrigin;
          float moyoMacro = moyoNoise(moyoP * 0.42);
          float moyoGrain = moyoNoise(moyoP * 8.0);
          float moyoSilt = moyoNoise(moyoP * 2.5 + 17.0);
          float moyoWet = (1.0 - smoothstep(-0.08, 0.32, vMoyoSurfacePosition.y))
            * smoothstep(0.25, 0.75, moyoMacro);
          diffuseColor.rgb *= 0.72 + moyoMacro * 0.48 + moyoGrain * 0.18;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.69, 0.77, 0.70), moyoWet * 0.7);
          diffuseColor.rgb += vec3(0.025, 0.019, 0.010) * smoothstep(0.72, 0.92, moyoGrain) * moyoSilt;`)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor - moyoWet * 0.28 + (moyoGrain - 0.5) * 0.12, 0.55, 1.0);`);
      if (normals) shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        float moyoRelief = (moyoGrain * 0.014 + moyoSilt * 0.025) * (1.0 - moyoWet * 0.6);
        normal = moyoPerturbNormal(normal, moyoRelief);`);
    } else {
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <color_fragment>", `#include <color_fragment>
          vec2 moyoP = vMoyoSurfacePosition.xz + uMoyoOrigin;
          float moyoWave = moyoWaveHeight(moyoP, uMoyoTime);
          float moyoDepth = moyoNoise(moyoP * 0.65);
          diffuseColor.rgb *= 0.84 + moyoDepth * 0.28;
          float moyoGlint = smoothstep(0.027, 0.044, moyoWave) * 0.065;
          diffuseColor.rgb += vec3(0.51, 0.58, 0.48) * moyoGlint;`);
      if (normals) shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        normal = moyoPerturbNormal(normal, moyoWave);`);
    }
  };
  material.customProgramCacheKey = () => `${baseKey}|moyo-surface-v1:${kind}:${normals ? "bump" : "flat"}`;
  material.needsUpdate = true;
  return material;
}
