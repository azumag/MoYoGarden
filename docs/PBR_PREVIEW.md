# PBR high-resolution preview

`pbr-preview` branch contains the next rendering pipeline without changing the stable production renderer on `main`.

## Reliability model

The preview no longer waits for Three.js add-ons, glTF models, the API, the environment map, and shadows before showing the world.

1. A classic `boot.js` watchdog starts independently of the module graph.
2. Three.js core creates the renderer.
3. A procedural low-detail world is rendered and becomes interactive.
4. The API connects in parallel.
5. GLB files load in a two-worker queue and replace fallback objects one category at a time.
6. Shadows and the PMREM environment are enabled during idle time.
7. Any pre-interactive startup failure redirects the preview to the stable production site.

Each GLB request and parse has a bounded timeout. A missing model affects only that object category.

## Separate Cloudflare Worker

Use `wrangler.pbr.jsonc`. It deploys a separate Worker and Durable Object namespace:

```text
moyo-garden-pbr-preview
```

It has no custom-domain route and cannot replace `moyo.bluemoon.works`.

For a second Cloudflare Workers Builds project, use:

```text
Repository:        azumag/MoYoGarden
Production branch: pbr-preview
Root directory:    /
Build command:     npm run build
Deploy command:    npx wrangler deploy --config wrangler.pbr.jsonc
```

The resulting address is the `workers.dev` address shown by Wrangler or the Cloudflare dashboard.

## Quality profiles

```text
?quality=balanced
?quality=high
?quality=ultra
```

With no query, the browser selects a profile from viewport size, `deviceMemory`, CPU concurrency, and reduced-motion preference.

| Profile | DPR cap | Shadow map | PMREM size | Detail density |
|---|---:|---:|---:|---:|
| balanced | 1.30 | 1024 | 64 | 0.62 |
| high | 1.65 | 2048 | 128 | 0.86 |
| ultra | 2.00 | 2048 | 256 | 1.00 |

`?quality=low`, `?renderer=compat`, and `?safe=1` open the stable production renderer instead.

## Local verification

```bash
npm install
npm run verify
npm run dev:pbr-preview
```

The build validates the progressive boot path, watchdog fallback, minified Three.js runtime, dynamic add-on loading, GLB structure, PBR materials, LOD, bounded model loading, deferred environment lighting, throttled shadows, and the isolated preview Worker config.
