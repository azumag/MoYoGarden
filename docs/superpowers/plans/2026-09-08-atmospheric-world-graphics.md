# Atmospheric world graphics implementation plan

**Goal:** Make the existing decayed 3D world materially richer without changing simulation or hex topology.
**Architecture:** Optional renderer extension after existing terrain/seam patches. World-space material detail, a layered sky, and bounded instanced ground cover use the existing Three.js runtime. No external textures, CDN, post-processing buffers, or simulation writes.
**Baseline:** main f0f58e313bc8384f12d2cfbc67467b2dd6b891e3; 238 passing tests.

## Constraints
- Preserve current/adjacent live simulation, 10-second synchronization, and static terrain-only outer ring.
- Never displace welded terrain/water boundary vertices or alter picking coordinates.
- Keep authored model fallbacks and progressive startup; SAFE and reduced motion remain available.
- Deterministic cosmetic placement; no use of simulation RNG and no retained disposed materials.
- Cloudflare Workers Builds performs deployment; GitHub CI only verifies it.

## Implementation
- [ ] Add failing material tests in tests/surface-materials.test.mjs. Exercise actual Three.js ShaderLib hooks, clone reinstallation, program cache separation, shared time, and geometry invariance.
- [ ] Implement public/client/surface-materials.js: createSurfaceUniforms(), applySurfaceMaterial(material, kind, uniforms, options). Inject world-space noise/bump and analytic water wave normals without texture requests or position displacement. Preserve existing shader hooks and clipping.
- [ ] Add failing ground-cover tests. Implement public/client/ground-cover.js: createGroundCover(terrainMesh, state, quality, uniforms), deterministic barycentric sampling of the actual rendered surface, water/structure exclusion, bounded single InstancedMesh, no micro-shadows.
- [ ] Integrate public/client/world-atmosphere.js after decay-dressing in boot.js. Decorate rebuilt current and neighbor surfaces, share animation uniforms, update the sky once, and respect reduced motion. Prevent legacy water color cycling from overriding the new material.
- [ ] Build, run all tests, and use tools/render-graphics-smoke.mjs with Playwright and real WebGL to compare fixed-state before/after scenes, SAFE, reduced motion, and repeated terrain replacement.
- [ ] Review diff and latest main, create PR, verify latest-head CI and Cloudflare preview, then merge only that tested head.
- [ ] Verify production /api/meta commit matches merge SHA, /api/health succeeds, and actual browser startup has no shader/module errors.

## Acceptance
Material/grass tests fail before implementation and pass after. Existing simulation/seam tests remain green. Browser captures show richer terrain, rippled water, ground vegetation and layered sky without extra network assets. Live and terrain-only neighbor contracts remain unchanged. Record measured timings as device-specific evidence, not general FPS guarantees.
