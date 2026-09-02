import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = "public/assets/authored/kaykit-adventurers";
const manifest = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));
const notice = await readFile(join(ROOT, "NOTICE.txt"), "utf8");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const modelLibrary = await readFile("public/client/model-library.js", "utf8");
const agents = await readFile("public/client/agents.js", "utf8");
const vendor = await readFile("scripts/vendor-authored-characters.mjs", "utf8");

assert.equal(packageJson.version, "0.3.11");
assert.match(packageJson.scripts["vendor:authored:characters"], /vendor-authored-characters\.mjs/);
assert.match(packageJson.scripts["build:web"], /vendor:authored:characters/);
assert.match(packageJson.scripts["build:web"], /validate-authored-characters\.mjs/);

assert.equal(manifest.version, "0.3.11");
assert.equal(manifest.upstreamRepo, "KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0");
assert.equal(manifest.upstreamCommit, "672074b73ba276876a19e8816ecdc5241817ab47");
assert.ok(Array.isArray(manifest.loaded));
assert.ok(Array.isArray(manifest.failed));
assert.match(notice, /Creative Commons Zero \(CC0\)/);
assert.match(notice, /Character Pack - Adventurers/);

assert.match(vendor, /672074b73ba276876a19e8816ecdc5241817ab47/);
assert.match(vendor, /66d312ab6dc02b35fb648e7585bfdddb4e02eeef/);
assert.match(vendor, /5d2b1403240d5f9ffff12e02c007572038eca2a8/);
assert.match(vendor, /29d2db09000ac28e626cf24c3d5ff48f7c324351/);
assert.match(vendor, /542954baba7281f028f93306943fc780b1ebcf55/);
assert.match(vendor, /MOYO_REQUIRE_AUTHORED_CHARACTERS/);
assert.match(vendor, /document\.skins/);
assert.match(vendor, /document\.animations/);

assert.match(modelLibrary, /AUTHORED_CHARACTER_VERSION\s*=\s*"0\.3\.11"/);
assert.match(modelLibrary, /authored:agent-worker/);
assert.match(modelLibrary, /authored:agent-roamer/);
assert.match(modelLibrary, /SkeletonUtils\.js/);
assert.match(modelLibrary, /this\.skeletonClone\s*=\s*SkeletonUtils\.clone/);
assert.match(modelLibrary, /this\.animations\s*=\s*new Map/);
assert.match(modelLibrary, /clips\(name\)/);
assert.match(modelLibrary, /authored:agent-.*return "settler"/s);
assert.match(modelLibrary, /Math\.max\(timeoutMs,\s*6_500\)/);

assert.match(agents, /AUTHORED_AGENT_BY_ROLE/);
assert.match(agents, /authored:agent-worker/);
assert.match(agents, /authored:agent-roamer/);
assert.match(agents, /fitAuthoredAgent/);
assert.match(agents, /AnimationMixer/);
assert.match(agents, /findClip/);
assert.match(agents, /walking\[_ -\]\?a/i);
assert.match(agents, /moyoAuthoredAgent/);
assert.match(agents, /disposeAgentEntry/);

for (const asset of manifest.loaded) {
  const path = join(ROOT, asset.file);
  const info = await stat(path);
  assert.ok(info.isFile());
  assert.ok(info.size > 1_000_000, `${asset.file} is unexpectedly small`);
  const data = await readFile(path);
  assert.equal(data.toString("ascii", 0, 4), "glTF", `${asset.file} is not GLB`);
  assert.equal(data.readUInt32LE(4), 2, `${asset.file} is not glTF 2.0`);
  assert.equal(data.readUInt32LE(8), data.length, `${asset.file} GLB length mismatch`);
  const jsonLength = data.readUInt32LE(12);
  assert.equal(data.toString("ascii", 16, 20), "JSON", `${asset.file} lacks JSON chunk`);
  const document = JSON.parse(data.toString("utf8", 20, 20 + jsonLength).trim());
  assert.ok(Array.isArray(document.skins) && document.skins.length > 0, `${asset.file} lacks a skin`);
  assert.ok(Array.isArray(document.animations) && document.animations.length > 0, `${asset.file} lacks animations`);
  for (const image of document.images || []) {
    if (typeof image.uri !== "string") continue;
    const imageInfo = await stat(join(ROOT, image.uri));
    assert.ok(imageInfo.isFile(), `${asset.file} external image ${image.uri} is missing`);
  }
}

console.log(`Authored character validation passed (${manifest.loaded.length} loaded, ${manifest.failed.length} fallback)`);
