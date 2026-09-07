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
    vec3 moyoRipple = vec3(cos(moyoA)*0.085 + cos(moyoB)*0.045,
      0.0, sin(moyoA)*0.045 - sin(moyoB)*0.065);
    moyoRipple.xz += vec2(cos(moyoC), sin(moyoC)) * 0.018 * moyoFade;
    normal = normalize(normal + mat3(viewMatrix) * moyoRipple * moyoFade);
  `).replace('#include <color_fragment>', `
    #include <color_fragment>
    float moyoSwell = moyoNoise(vMoyoWorld.xz * 0.32 + vec2(moyoTime * 0.008));
    diffuseColor.rgb *= mix(vec3(0.52,0.72,0.73), vec3(0.94,1.06,0.98), moyoSwell);
  `).replace('#include <opaque_fragment>', `
    // A restrained horizon tint complements PBR specular without another pass.
    float moyoFresnel = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 5.0);
    outgoingLight = mix(outgoingLight, vec3(0.38,0.48,0.48), moyoFresnel * 0.32);
    #include <opaque_fragment>
  `);
}
