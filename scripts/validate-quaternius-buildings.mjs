import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = "public/assets/authored/quaternius-buildings";
const EXPECTED = ["camp.glb", "storehouse.glb", "market.glb", "workshop.glb"];
const manifest = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));
const notice = await readFile(join(ROOT, "NOTICE.txt"), "utf8");

assert.equal(manifest.version, "0.3.11-q3");
assert.equal(manifest.upstreamRepo, "agentkaerf/FreeModels");
assert.equal(manifest.upstreamCommit, "db3df04d1e4714298a09510b26fb6de6645138a2");
assert.equal(manifest.license, "CC0-1.0");
assert.ok(Array.isArray(manifest.loaded));
assert.ok(Array.isArray(manifest.failed));
assert.equal(manifest.loaded.length + manifest.failed.length, EXPECTED.length);
assert.match(notice, /Quaternius Medieval Village MegaKit Standard/);
assert.match(notice, /CC0 1\.0/);
assert.match(notice, /Only geometry is retained/);

function parseGlb(bytes, file) {
  assert.equal(bytes.toString("ascii", 0, 4), "glTF", `${file} is not GLB`);
  assert.equal(bytes.readUInt32LE(4), 2, `${file} is not glTF 2.0`);
  assert.equal(bytes.readUInt32LE(8), bytes.length, `${file} length header is invalid`);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.toString("ascii", 16, 20), "JSON", `${file} lacks JSON chunk`);
  return JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).trim());
}

for (const asset of manifest.loaded) {
  assert.ok(EXPECTED.includes(asset.file), `${asset.file} is not an expected building shell`);
  const path = join(ROOT, asset.file);
  const info = await stat(path);
  assert.ok(info.isFile(), `${asset.file} must be a file`);
  assert.ok(info.size > 1_000, `${asset.file} is unexpectedly small`);
  assert.ok(info.size < 256 * 1024, `${asset.file} is unexpectedly large`);
  const document = parseGlb(await readFile(path), asset.file);

  assert.ok(!document.images?.length, `${asset.file} still embeds image references`);
  assert.ok(!document.textures?.length, `${asset.file} still embeds texture references`);
  assert.ok(!document.samplers?.length, `${asset.file} still embeds sampler references`);
  assert.equal(document.buffers?.length, 1, `${asset.file} must have one packed buffer`);
  assert.ok(!document.buffers[0].uri, `${asset.file} still has an external buffer URI`);
  assert.ok(document.nodes?.length >= 6, `${asset.file} lacks modular shell nodes`);
  assert.ok(document.meshes?.length >= 5, `${asset.file} lacks shared modular meshes`);
  assert.ok(document.materials?.length >= 4, `${asset.file} lacks decayed PBR materials`);
  assert.ok(document.nodes.some((node) => node.extras?.silhouetteRole), `${asset.file} lacks silhouette role metadata`);

  const minY = Number(document.extras?.moyoBounds?.minY);
  const maxY = Number(document.extras?.moyoBounds?.maxY);
  assert.ok(Number.isFinite(minY) && Math.abs(minY) <= 0.0001, `${asset.file} is not grounded at y=0`);
  assert.ok(Number.isFinite(maxY) && maxY > 0.5, `${asset.file} has invalid vertical bounds`);

  for (const material of document.materials) {
    assert.ok(material.pbrMetallicRoughness, `${asset.file} material lacks PBR factors`);
    assert.ok(!material.normalTexture, `${asset.file} material still has normalTexture`);
    assert.ok(!material.pbrMetallicRoughness.baseColorTexture, `${asset.file} material still has baseColorTexture`);
    assert.ok(!material.pbrMetallicRoughness.metallicRoughnessTexture, `${asset.file} material still has metallicRoughnessTexture`);
  }
}

console.log(`Quaternius building validation passed (${manifest.loaded.length} loaded, ${manifest.failed.length} KayKit fallback)`);
