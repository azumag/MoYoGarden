# Atmospheric graphics implementation and verification

## Scope
Improve the existing WebGL renderer, preserving simulation, API, six-way region navigation,
live adjacent objects at 10-second intervals and the static terrain-only outer ring.
No runtime dependencies, external texture downloads, framebuffer postprocessing or vertex displacement.

## Changes
- World-space terrain mineral/grain variation and filtered micro normals; identical shader on neighboring surfaces.
- Shared-clock analytic water ripple normals, preserving shore and boundary positions.
- Layered procedural overcast sky, with output color conversion and no sun orb.
- Quality-bounded instanced dry grass (one draw), and terrain-conforming contact shadows (one draw).
- Olive foliage and nonmetallic bark instead of bright turquoise authored vegetation.
- Actual triangle-height sampling, deterministic scatter, explicit GPU disposal, deferred creation,
  no rebuilding on unchanged ticks, and reduced-motion/safe-mode support.

## Verification procedure
1. Run `npm test` before editing and observe a clean baseline.
2. Write failing surface, scatter, lifecycle and foliage tests; implement and rerun.
3. Run `npm run build` and `node scripts/visual-smoke.mjs high` using installed Playwright.
   `PLAYWRIGHT_MODULE` may specify an existing Playwright ES module; `PLAYWRIGHT_CHANNEL=chrome`
   uses installed Chrome. Outputs go to `/tmp/moyo-visual-after-high` by default.
4. Inspect actual browser screenshots and error logs for high, balanced and low/safe profiles.
   `MOYO_VISUAL_BASELINE=1` disables the atmospheric extension for shader/cover comparisons;
   it does not undo the foliage palette correction. The production screenshot taken before changes
   is the complete baseline.
5. Review the diff, rerun tests after corrections, create a PR, check latest HEAD CI and comments.
6. Merge only after passing checks; verify Cloudflare production `/api/meta` build SHA matches the
   merged SHA and `/api/health` succeeds. Do not replace Cloudflare deployment with Actions.
