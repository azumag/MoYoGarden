# Quaternius decay props

MoYoGarden optionally uses a small set of geometry from Quaternius' Medieval Village MegaKit Standard for ruined-world dressing. The upstream Standard pack is CC0 1.0.

The build does not copy the pack's multi-megabyte texture set. `scripts/vendor-quaternius-decay.mjs` downloads three pinned glTF meshes, validates their Git blob SHAs, removes texture/image/sampler references, assigns MoYoGarden's muted PBR materials, and packs each result into a self-contained GLB. Runtime loading is optional; procedural decay geometry remains the fallback.
