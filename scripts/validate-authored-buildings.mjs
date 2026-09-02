import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = "public/assets/authored/kaykit";
const manifest = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));
const notice = await readFile(join(ROOT, "NOTICE.txt"), "utf8");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const modelLibrary = await readFile("public/client/model-library.js", "utf8");
const vendor = await readFile("scripts/vendor-authored-buildings.mjs", "utf8");

assert.equal(packageJson.version, "0.3.11");
assert.match(packageJson.scripts["vendor:authored:buildings"], /vendor-authored-buildings\.mjs/);
assert.match(packageJson.scripts["build:web"], /vendor:authored:buildings/);
assert.match(packageJson.scripts["build:web"], /validate-authored-buildings\.mjs/);

assert.equal(manifest.version, "0.3.10");
assert.equal(manifest.upstreamRepo, "KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0");
assert.equal(manifest.upstreamCommit, "84fa4e91af6a88989be7c99e0891cede11f2ca38");
assert.ok(Array.isArray(manifest.loaded));
assert.ok(Array.isArray(manifest.failed));
assert.match(notice, /Creative Commons Zero \(CC0\)/);
assert.match(notice, /KayKit: Medieval Hexagon Pack \(1\.0\)/);

assert.match(vendor, /84fa4e91af6a88989be7c99e0891cede11f2ca38/);
assert.match(vendor, /14cdc253646e4dba3cb7a267a6f7399b78ba2231/);
assert.match(vendor, /building_home_A_red/);
assert.match(vendor, /building_lumbermill_red/);
assert.match(vendor, /building_market_red/);
assert.match(vendor, /building_blacksmith_red/);
assert.match(vendor, /buildGlb/);
assert.match(vendor, /gitBlobSha/);

for (const key of [
  "authored:building-camp",
  "authored:building-storehouse",
  "authored:building-market",
  "authored:building-workshop",
]) assert.match(modelLibrary, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(modelLibrary, /AUTHORED_BUILDING_BY_CHILD/);
assert.match(modelLibrary, /authored:building-.*return "buildings"/s);
assert.match(modelLibrary, /fitAuthoredBuilding/);
assert.match(modelLibrary, /moyoAuthoredBuilding/);

for (const asset of manifest.loaded) {
  const path = join(ROOT, asset.file);
  const info = await stat(path);
  assert.ok(info.isFile());
  assert.ok(info.size > 1000, `${asset.file} is unexpectedly small`);
  const data = await readFile(path);
  assert.equal(data.toString("ascii", 0, 4), "glTF", `${asset.file} is not GLB`);
  assert.equal(data.readUInt32LE(4), 2, `${asset.file} is not glTF 2.0`);
  assert.equal(data.readUInt32LE(8), data.length, `${asset.file} GLB length mismatch`);
  const jsonLength = data.readUInt32LE(12);
  assert.equal(data.toString("ascii", 16, 20), "JSON", `${asset.file} lacks JSON chunk`);
  const document = JSON.parse(data.toString("utf8", 20, 20 + jsonLength).trim());
  assert.match(document.asset.generator || "", /MoYoGarden authored building packer/);
  assert.equal(document.buffers?.length, 1);
  assert.equal(document.buffers[0].uri, undefined, `${asset.file} retained external buffer URI`);
  assert.ok(document.images?.length > 0, `${asset.file} lacks image`);
  for (const image of document.images) {
    assert.equal(image.uri, undefined, `${asset.file} retained external image URI`);
    assert.equal(image.mimeType, "image/png");
    assert.ok(Number.isInteger(image.bufferView));
  }
}

console.log(`Authored building validation passed (${manifest.loaded.length} loaded, ${manifest.failed.length} fallback)`);
