import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = "public/assets/authored/quaternius-decay";
const manifest = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));
const notice = await readFile(join(ROOT, "NOTICE.txt"), "utf8");

assert.equal(manifest.version, "0.3.11-q1");
assert.equal(manifest.upstreamRepo, "agentkaerf/FreeModels");
assert.equal(manifest.upstreamCommit, "db3df04d1e4714298a09510b26fb6de6645138a2");
assert.equal(manifest.license, "CC0-1.0");
assert.ok(Array.isArray(manifest.loaded));
assert.ok(Array.isArray(manifest.failed));
assert.equal(manifest.loaded.length + manifest.failed.length, 3);
assert.match(notice, /Quaternius Medieval Village MegaKit Standard/);
assert.match(notice, /CC0 1\.0/);
assert.match(notice, /Only geometry is retained/);

function parseGlb(bytes, file) {
  assert.equal(bytes.toString("ascii", 0, 4), "glTF", `${file} is not GLB`);
  assert.equal(bytes.readUInt32LE(4), 2, `${file} is not glTF 2.0`);
  assert.equal(bytes.readUInt32LE(8), bytes.length, `${file} length header is invalid`);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.toString("ascii", 16, 20), "JSON", `${file} lacks JSON chunk`);
  const document = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).trim());
  return document;
}

for (const asset of manifest.loaded) {
  const path = join(ROOT, asset.file);
  const info = await stat(path);
  assert.ok(info.isFile(), `${asset.file} must be a file`);
  assert.ok(info.size > 100, `${asset.file} is unexpectedly small`);
  assert.ok(info.size < 256 * 1024, `${asset.file} is unexpectedly large`);
  const data = await readFile(path);
  const document = parseGlb(data, asset.file);

  assert.ok(!document.images?.length, `${asset.file} still embeds image references`);
  assert.ok(!document.textures?.length, `${asset.file} still embeds texture references`);
  assert.ok(!document.samplers?.length, `${asset.file} still embeds sampler references`);
  assert.ok(document.buffers?.length === 1, `${asset.file} must have one packed buffer`);
  assert.ok(!document.buffers[0].uri, `${asset.file} still has an external buffer URI`);
  assert.ok(document.materials?.length > 0, `${asset.file} lacks a PBR material`);

  for (const material of document.materials) {
    assert.ok(material.pbrMetallicRoughness, `${asset.file} material lacks PBR factors`);
    assert.ok(!material.normalTexture, `${asset.file} material still has normalTexture`);
    assert.ok(!material.occlusionTexture, `${asset.file} material still has occlusionTexture`);
    assert.ok(!material.emissiveTexture, `${asset.file} material still has emissiveTexture`);
    assert.ok(!material.pbrMetallicRoughness.baseColorTexture, `${asset.file} material still has baseColorTexture`);
    assert.ok(!material.pbrMetallicRoughness.metallicRoughnessTexture, `${asset.file} material still has metallicRoughnessTexture`);
  }
}

console.log(`Quaternius decay validation passed (${manifest.loaded.length} loaded, ${manifest.failed.length} fallback)`);
