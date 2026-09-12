import { resolveQualityProfile } from './quality.js';
import { patchWaterShader } from './water-shading.js';
// Detail in world space keeps every independently rendered hex on the same
// material field. No displacement: picking, shorelines and welded seams stay put.
const styled = new WeakSet();
const ZERO_ORIGIN = { value: { x: 0, y: 0 } };
export const NOISE_GLSL = `
float moyoHash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float moyoNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(moyoHash(i), moyoHash(i+vec2(1.0,0.0)), f.x),
             mix(moyoHash(i+vec2(0.0,1.0)), moyoHash(i+vec2(1.0)), f.x), f.y);
}
`;

export function styleSurface(material, kind, clock, options = {}) {
  if (!material?.isMeshStandardMaterial || styled.has(material)) return;
  styled.add(material);
  material.userData.moyoSurfaceKind = kind;
  material.userData.moyoDecayStyled = true;
  const quality = options.quality ?? resolveQualityProfile();
  const waterQuality = kind === 'water' ? (options.waterQuality ?? quality.waterQuality) : 'none';
  const simpleLand = kind === 'land' && (quality.label === 'SAFE' || ['safe', 'low', 'light'].includes(quality.requested));
  const worldOrigin = options.worldOrigin ?? ZERO_ORIGIN;
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${previousKey}:moyo-surface-v3:${kind}:${waterQuality}:${simpleLand ? 'simple' : 'detail'}`;
  if (kind === 'water') {
    material.color.set(0x678d89);
    material.roughness = waterQuality === 'simple' ? 0.42 : 0.19;
    material.metalness = 0;
    material.envMapIntensity = 0.8;
    material.opacity = 0.88;
    if (material.isMeshPhysicalMaterial) {
      material.transmission = 0;
      material.clearcoat = waterQuality === 'simple' ? 0 : 0.38;
      material.clearcoatRoughness = 0.24;
    }
  }
  material.onBeforeCompile = function(shader, renderer) {
    previous.call(this, shader, renderer);
    if ((kind === 'water' && waterQuality === 'simple') || simpleLand) return;
    shader.uniforms.moyoTime = clock;
    shader.uniforms.moyoWorldOrigin = worldOrigin;
    shader.vertexShader = 'varying vec3 vMoyoWorld;\nuniform vec2 moyoWorldOrigin;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      #include <project_vertex>
      vec4 moyoWorld = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        moyoWorld = instanceMatrix * moyoWorld;
      #endif
      vMoyoWorld = (modelMatrix * moyoWorld).xyz;
      vMoyoWorld.xz += moyoWorldOrigin;
    `);
    shader.fragmentShader = `varying vec3 vMoyoWorld;\nuniform float moyoTime;\n${NOISE_GLSL}` + shader.fragmentShader;
    if (kind === 'water') {
      patchWaterShader(shader, waterQuality);
    } else {
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        vec2 p = vMoyoWorld.xz;
        float moyoFootprint = length(fwidth(p));
        float moyoFineFade = 1.0 - smoothstep(0.035, 0.18, moyoFootprint);
        float broad = moyoNoise(p * 0.42);
        float grain = mix(0.5, moyoNoise(p * 19.0), moyoFineFade);
        float patches = smoothstep(0.36, 0.75, moyoNoise(p * 1.6 + broad));
        // Broken mineral veins and stratified soil remain continuous across hex seams.
        float veinField = moyoNoise(p * 3.4 + vec2(broad * 1.7));
        float veins = (1.0 - smoothstep(0.012, 0.052 + moyoFootprint * 0.10, abs(veinField - 0.51))) * moyoFineFade;
        float strata = sin(vMoyoWorld.y * 33.0 + broad * 7.0) * 0.5 + 0.5;
        float dry = smoothstep(-0.14, 0.2, vMoyoWorld.y);
        diffuseColor.rgb *= 0.70 + broad * 0.40 + grain * 0.14;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.14,1.02,0.82), patches * 0.48);
        diffuseColor.rgb *= 1.0 - veins * 0.19;
        diffuseColor.rgb *= mix(0.69, 1.0, dry);
        float moyoRelief = (grain - 0.5) * 0.016 - veins * 0.020 + patches * 0.025;
      `).replace('#include <roughnessmap_fragment>', `
        #include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor - (1.0-dry) * 0.22 - patches * 0.06, 0.64, 1.0);
      `).replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        // Derivative bump mapping follows the actual slope, not a fixed up-plane.
        vec3 moyoDx = dFdx(-vViewPosition), moyoDy = dFdy(-vViewPosition);
        vec3 moyoR1 = cross(moyoDy, normal), moyoR2 = cross(normal, moyoDx);
        float moyoDet = dot(moyoDx, moyoR1);
        float moyoBumpScale = min(1.0, abs(moyoDet) / 0.00001);
        vec3 moyoGradient = sign(moyoDet) * (dFdx(moyoRelief) * moyoR1 + dFdy(moyoRelief) * moyoR2);
        normal = normalize(abs(moyoDet) * normal - moyoGradient * moyoBumpScale + normal * 0.0000001);
        vec3 moyoWorldNormal = inverseTransformDirection(normal, viewMatrix);
        float moyoSlope = 1.0 - smoothstep(0.60, 0.96, abs(moyoWorldNormal.y));
        diffuseColor.rgb *= 1.0 - moyoSlope * (0.10 + strata * 0.09);
      `);
    }
  };
  material.needsUpdate = true;
}

// A spatial index over the actual, welded triangles. Decorations must not use
// tile-center heights, which float above or sink below the smoothed surface.
export function createSurfaceSampler(geometry) {
  const positions = geometry?.getAttribute('position');
  if (!positions) return () => undefined;
  const index = geometry.index;
  const count = index?.count ?? positions.count;
  const bins = new Map();
  for (let i = 0; i + 2 < count; i += 3) {
    const t = [0,1,2].map(n => {
      const j = index ? index.getX(i+n) : i+n;
      return [positions.getX(j), positions.getY(j), positions.getZ(j)];
    });
    const xs = t.map(p => p[0]), zs = t.map(p => p[2]);
    for (let x=Math.floor(Math.min(...xs)); x<=Math.floor(Math.max(...xs)); x++) {
      for (let z=Math.floor(Math.min(...zs)); z<=Math.floor(Math.max(...zs)); z++) {
        const key = `${x}:${z}`;
        if (!bins.has(key)) bins.set(key, []);
        bins.get(key).push(t);
      }
    }
  }
  return (x,z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return undefined;
    let result;
    for (const [a,b,c] of bins.get(`${Math.floor(x)}:${Math.floor(z)}`) ?? []) {
      const den = (b[2]-c[2])*(a[0]-c[0]) + (c[0]-b[0])*(a[2]-c[2]);
      if (Math.abs(den) < 1e-10) continue;
      const u = ((b[2]-c[2])*(x-c[0]) + (c[0]-b[0])*(z-c[2])) / den;
      const v = ((c[2]-a[2])*(x-c[0]) + (a[0]-c[0])*(z-c[2])) / den;
      if (u < -1e-6 || v < -1e-6 || u+v > 1+1e-6) continue;
      const y = u*a[1] + v*b[1] + (1-u-v)*c[1];
      result = result === undefined ? y : Math.max(result,y);
    }
    return result;
  };
}
