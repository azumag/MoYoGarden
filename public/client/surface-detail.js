import { resolveQualityProfile } from './quality.js';
import { patchWaterShader } from './water-shading.js';
// Detail in world space keeps every independently rendered hex on the same
// material field. No displacement: picking, shorelines and welded seams stay put.
const styled = new WeakSet();
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
  const waterQuality = kind === 'water' ? (options.waterQuality ?? resolveQualityProfile().waterQuality) : 'none';
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${previousKey}:moyo-surface-v2:${kind}:${waterQuality}`;
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
    if (kind === 'water' && waterQuality === 'simple') return;
    shader.uniforms.moyoTime = clock;
    shader.vertexShader = 'varying vec3 vMoyoWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      #include <project_vertex>
      vec4 moyoWorld = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        moyoWorld = instanceMatrix * moyoWorld;
      #endif
      vMoyoWorld = (modelMatrix * moyoWorld).xyz;
    `);
    shader.fragmentShader = `varying vec3 vMoyoWorld;\nuniform float moyoTime;\n${NOISE_GLSL}` + shader.fragmentShader;
    if (kind === 'water') {
      patchWaterShader(shader, waterQuality);
    } else {
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        vec2 p = vMoyoWorld.xz;
        float broad = moyoNoise(p * 0.42);
        float grain = moyoNoise(p * 19.0);
        float patches = smoothstep(0.4, 0.75, moyoNoise(p * 1.6 + broad));
        diffuseColor.rgb *= 0.72 + broad * 0.46 + grain * 0.15;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.13,0.99,0.75), patches * 0.45);
      `).replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        // Screen-space footprint suppresses subpixel grit instead of shimmering.
        float detailFade = 1.0 - smoothstep(0.045, 0.22, length(fwidth(vMoyoWorld.xz)));
        vec2 grit = vec2(moyoNoise(vMoyoWorld.xz*16.0), moyoNoise(vMoyoWorld.zx*16.0+7.0)) - 0.5;
        normal = normalize(normal + mat3(viewMatrix) * vec3(grit.x,0.0,grit.y) * 0.19 * detailFade);
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
