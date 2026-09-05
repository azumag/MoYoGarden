import * as THREE from "three";
import { WorldView } from "./world-view.js";

const originalUpdateCamera = WorldView.prototype.updateCamera;
const DECAY_TINT = new THREE.Color(0x5b574d);
const DIRTY_WATER_TINT = new THREE.Color(0x3f5351);

function applyDecayedMaterial(material) {
  if (!material || material.userData?.moyoDecayStyled) return;
  material.userData = { ...(material.userData || {}), moyoDecayStyled: true };

  const factionMaterial = material.name?.includes("Faction");
  const wetMaterial = material.isMeshPhysicalMaterial && material.transparent;
  if (material.color?.isColor) {
    if (factionMaterial) {
      material.color.offsetHSL(0, -0.08, -0.03);
    } else {
      material.color.offsetHSL(0, -0.18, -0.08);
      material.color.lerp(wetMaterial ? DIRTY_WATER_TINT : DECAY_TINT, wetMaterial ? 0.18 : 0.12);
    }
  }

  if (Number.isFinite(material.roughness)) {
    material.roughness = Math.max(material.roughness, wetMaterial ? 0.48 : factionMaterial ? 0.72 : 0.88);
  }
  if (Number.isFinite(material.metalness) && !factionMaterial) {
    material.metalness = Math.min(material.metalness, 0.08);
  }
  if (Number.isFinite(material.envMapIntensity)) {
    material.envMapIntensity = Math.min(material.envMapIntensity, factionMaterial ? 0.62 : 0.48);
  }
  material.needsUpdate = true;
}

function applyDecayedWorldGrade(view) {
  if (!view.moyoDecayGradeApplied) {
    view.moyoDecayGradeApplied = true;
    view.renderer.toneMappingExposure = 0.78;
    view.scene.background.set(0x666b64);
    view.scene.fog.color.set(0x656a63);
    view.scene.fog.density = 0.0148;

    view.hemi.color.set(0xb7b9aa);
    view.hemi.groundColor.set(0x343934);
    view.hemi.intensity = 1.08;
    view.ambient.color.set(0x8d9187);
    view.ambient.intensity = 0.16;
    view.sun.color.set(0xd1b98f);
    view.sun.intensity = 2.05;

    const uniforms = view.sky?.material?.uniforms;
    uniforms?.zenithColor?.value?.set?.(0x4d5960);
    uniforms?.horizonColor?.value?.set?.(0x858477);
    uniforms?.groundColor?.value?.set?.(0x474c44);
    uniforms?.sunColor?.value?.set?.(0xbfa77e);
  }

  view.scene.environmentIntensity = 0.42;

  const now = performance.now();
  if (now < (view.moyoNextDecaySweep || 0)) return;
  view.moyoNextDecaySweep = now + 900;
  view.scene.traverse((object) => {
    if (!object.isMesh || !object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) applyDecayedMaterial(material);
  });
}

WorldView.prototype.updateCamera = function updateCameraWithoutSkyOrb() {
  originalUpdateCamera.call(this);
  applyDecayedWorldGrade(this);

  const sky = this.sky;
  const material = sky?.material;
  if (!sky || !material?.isShaderMaterial) return;

  // Keep the dome centered on the camera so it behaves like a backdrop rather
  // than a physical sphere as the camera pans around the world.
  sky.position.copy(this.camera.position);

  if (sky.userData.moyoOrbFixApplied) return;
  sky.userData.moyoOrbFixApplied = true;

  // The old sky shader drew a compact high-power sun disc. At gameplay scale
  // it read as an unexplained ball in the distance. Keep only a broad,
  // directionless horizon glow and let the DirectionalLight provide sunlight.
  material.depthTest = false;
  material.fragmentShader = `
    varying vec3 vDirection;
    uniform vec3 zenithColor;
    uniform vec3 horizonColor;
    uniform vec3 groundColor;
    uniform vec3 sunColor;
    void main() {
      vec3 dir = normalize(vDirection);
      float up = clamp(dir.y, -1.0, 1.0);
      float skyMix = pow(clamp(up, 0.0, 1.0), 0.55);
      vec3 color = mix(horizonColor, zenithColor, skyMix);
      float below = 1.0 - smoothstep(-0.32, 0.05, up);
      color = mix(color, groundColor, below * 0.62);
      float horizonGlow = exp(-abs(up) * 8.0) * 0.045;
      color += sunColor * horizonGlow;
      gl_FragColor = vec4(color, 1.0);
    }
  `;
  material.needsUpdate = true;
};
