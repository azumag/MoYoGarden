# MoYoGarden glTF assets

The files in this directory are compact glTF 2.0 binary models generated for
MoYoGarden and released under the repository's MIT license.

- `settler.glb`: humanoid resident with named animation pivots and role tools
- `tree.glb`: trunk, branches, and layered foliage
- `rock.glb`: rock cluster with a metallic ore detail
- `buildings.glb`: camp, storehouse, market, and workshop scenes

They use the glTF metallic-roughness PBR material model. Source generation code
is in `scripts/generate-models.mjs`; run it from any working directory with:

```bash
node scripts/generate-models.mjs
```

Production builds run the Node.js generator before validation. The generated GLB
files are ignored by Git, included in the Cloudflare Static Assets upload, and
loaded directly by the browser.
