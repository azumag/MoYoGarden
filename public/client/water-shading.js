// Shading only: no displaced shore vertices, offscreen reflection or transmission.
export function patchWaterShader(shader, quality) {
  if (quality === 'simple') return;
  shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
    #include <normal_fragment_maps>
    vec2 moyoP = vMoyoWorld.xz;
    float moyoFade = 1.0 - smoothstep(0.035, 0.32, length(fwidth(moyoP)));
    float moyoA = dot(moyoP, vec2(2.2, 0.9)) + moyoTime * 0.85;
    float moyoB = dot(moyoP, vec2(-1.3, 3.1)) - moyoTime * 0.62;
    float moyoC = dot(moyoP, vec2(8.1, 4.3)) + moyoTime * 1.35;
    float moyoLong = dot(moyoP, vec2(0.42, 0.18)) - moyoTime * 0.32;
    // Each slope is the derivative of its wave height; crossing wave trains
    // produce coherent moving highlights rather than independently wobbling axes.
    vec2 moyoSlope = vec2(2.2,0.9) * cos(moyoA) * 0.033
      + vec2(-1.3,3.1) * cos(moyoB) * 0.018
      + vec2(0.42,0.18) * cos(moyoLong) * 0.07;
    moyoSlope += vec2(8.1,4.3) * cos(moyoC) * 0.0025 * moyoFade;
    vec3 moyoRipple = vec3(moyoSlope.x, 0.0, moyoSlope.y);
    normal = normalize(normal + mat3(viewMatrix) * moyoRipple * moyoFade);
  `).replace('#include <color_fragment>', `
    #include <color_fragment>
    float moyoSwell = moyoNoise(vMoyoWorld.xz * 0.32 + vec2(moyoTime * 0.008));
    diffuseColor.rgb *= mix(vec3(0.52,0.72,0.73), vec3(0.94,1.06,0.98), moyoSwell);
  `).replace('#include <opaque_fragment>', `
    // A restrained horizon tint complements PBR specular without another pass.
    float moyoFresnel = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 5.0);
    vec3 moyoReflected = inverseTransformDirection(reflect(-normalize(vViewPosition), normal), viewMatrix);
    vec3 moyoSkyReflection = mix(vec3(0.34,0.37,0.33), vec3(0.22,0.31,0.35), smoothstep(0.0,0.65,moyoReflected.y));
    outgoingLight = mix(outgoingLight, moyoSkyReflection, moyoFresnel * 0.40);
    #include <opaque_fragment>
  `);
}
