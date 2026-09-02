import { WorldView } from "./world-view.js";

const originalUpdateCamera = WorldView.prototype.updateCamera;

WorldView.prototype.updateCamera = function updateCameraWithoutSkyOrb() {
  originalUpdateCamera.call(this);

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
