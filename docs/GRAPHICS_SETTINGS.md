# Graphics settings and wasteland art direction

Open the gear button, choose **グラフィック設定**, then **保存して適用**.
Settings reload the client once so antialiasing, model loading and the shadow/environment
budgets change together; no live scene teardown or region-handoff rewrite is needed.

Preferences are allow-listed under localStorage `moyo-graphics-v1`. They are local to
this browser/origin, not synced to the server. Tokens remain in the existing session
storage path and are never copied into graphics preferences. Invalid/oversized/future
values fall back safely. Storage denial displays an error without reloading; reset
removes only the graphics key.

## Controls

- Presets: auto, light, balanced, high, ultra. Changing preset resets individual overrides.
- Resolution: CSS-pixel ratio cap 0.75 / 1 / 1.5 / 2; native device ratio remains an upper bound.
- Shadows: off / 512 / 1024 / 2048.
- Water: simple/static or world-space ripples with grazing-angle reflection colour.
- Grass/detail density: off / sparse / full; light mode always omits grass.
- Frame cap: 30 or 60 fps; hidden tabs do not render. This is a cap, not a guaranteed measured frame rate.

Light defaults to 1x, no antialiasing, no dynamic shadows, no PMREM environment, no GLB
loads, no grass, simple water and 30 fps. Advanced resolution/shadow/water/fps overrides
remain available. `?safe=1`, `?renderer=compat`, or `?quality=low` is a recovery override
that ignores saved custom settings. Valid quality URLs override the saved preset;
save/reset removes rendering-only URL overrides while preserving region and hash.

## Art and performance

The resident models are original procedural slender travellers: long limbs, small
heads, layered dusty cloth, wraps, leather packs, asymmetric scrap armour, broad hats
and faction armbands. Their proportion is consistent through all three LODs; the old
chunky authored character cannot replace them when GLBs finish loading. Existing role,
selection, movement, and joint animation contracts are retained. Geometry templates
are bounded to six roles times three LODs and shared; per-agent faction material is
owned and disposable. At most six body/material draws per near model and two per far
model, excluding existing contact shadow and selection ring.

Existing building/tree/rock meshes and UVs are retained with a low-saturation, rough,
dust/stone/rust material treatment. This is not a wholesale environment-mesh replacement
and uses no Kenshi asset files. Higher-fidelity bespoke building/scenery meshes remain
separate art work.

Water changes are shading-only: world coordinates keep region seams aligned, the
existing reduced-motion clock is reused, and subpixel ripples fade with screen-space
footprint. There is no vertex displacement, transmission, screen-space reflection,
planar reflection or extra render target/pass. Simple water omits these shader additions.

## Verification

`node --test tests/graphics-settings.test.mjs tests/graphics-runtime.test.mjs tests/water-shading.test.mjs`
checks persistence, safe overrides, failure behaviour, frame pacing, runtime budgets
and water hook contracts without a GPU. `npm test` additionally checks real Three.js
geometry/ownership through `wasteland-models.test.mjs` and the existing renderer suite.

Before production promotion, use a real browser at desktop and 375px: save each preset,
reload, verify persistence, compare water, zoom residents through LODs, select/walk agents,
traverse region boundaries and background/restore the tab. Measure frame time and draw
counts; unit tests do not establish visual quality or performance on the user's GPU.
