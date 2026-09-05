import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const required = [
  "public/index.html",
  "public/style.css",
  "public/boot.js",
  "public/app.js",
  "public/client/sky-fix.js",
  "public/client/shared.js",
  "public/client/quality.js",
  "public/client/model-library.js",
  "public/client/terrain.js",
  "public/client/resources.js",
  "public/client/structures.js",
  "public/client/agents.js",
  "public/client/world-view.js",
  "public/client/demo-state.js",
  "public/models/settler.glb",
  "public/models/tree.glb",
  "public/models/rock.glb",
  "public/models/buildings.glb",
  "scripts/vendor-authored-assets.mjs",
  "scripts/vendor-authored-buildings.mjs",
  "scripts/vendor-authored-characters.mjs",
  "scripts/validate-authored-buildings.mjs",
  "scripts/validate-authored-characters.mjs",
  "public/assets/authored/kenney/NOTICE.txt",
  "public/assets/authored/kenney/manifest.json",
  "public/assets/authored/kaykit/NOTICE.txt",
  "public/assets/authored/kaykit/manifest.json",
  "public/assets/authored/kaykit-adventurers/NOTICE.txt",
  "public/assets/authored/kaykit-adventurers/manifest.json",
  "public/vendor/three-r185/LICENSE",
  "public/vendor/three-r185/build/three.module.min.js",
  "public/vendor/three-r185/build/three.core.min.js",
  "public/vendor/three-r185/examples/jsm/loaders/GLTFLoader.js",
  "public/vendor/three-r185/examples/jsm/environments/RoomEnvironment.js",
  "public/vendor/three-r185/examples/jsm/utils/SkeletonUtils.js",
];

for (const path of required) {
  const info = await stat(path);
  assert.ok(info.isFile(), `${path} must be a file`);
  assert.ok(info.size > 40, `${path} is unexpectedly small`);
}

const [html, boot, app, skyFix, worldView, modelLibrary, resources, structures, agents] = await Promise.all([
  readFile("public/index.html", "utf8"),
  readFile("public/boot.js", "utf8"),
  readFile("public/app.js", "utf8"),
  readFile("public/client/sky-fix.js", "utf8"),
  readFile("public/client/world-view.js", "utf8"),
  readFile("public/client/model-library.js", "utf8"),
  readFile("public/client/resources.js", "utf8"),
  readFile("public/client/structures.js", "utf8"),
  readFile("public/client/agents.js", "utf8"),
]);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const previewConfig = JSON.parse(await readFile("wrangler.pbr.jsonc", "utf8"));
const authoredManifest = JSON.parse(await readFile("public/assets/authored/kenney/manifest.json", "utf8"));
const authoredNotice = await readFile("public/assets/authored/kenney/NOTICE.txt", "utf8");
const authoredVendor = await readFile("scripts/vendor-authored-assets.mjs", "utf8");
const buildingManifest = JSON.parse(await readFile("public/assets/authored/kaykit/manifest.json", "utf8"));
const buildingNotice = await readFile("public/assets/authored/kaykit/NOTICE.txt", "utf8");
const characterManifest = JSON.parse(await readFile("public/assets/authored/kaykit-adventurers/manifest.json", "utf8"));
const characterNotice = await readFile("public/assets/authored/kaykit-adventurers/NOTICE.txt", "utf8");

assert.equal(packageJson.version, "0.3.11");
assert.equal(packageJson.dependencies.three, "0.185.1");
assert.match(packageJson.scripts["vendor:authored"], /vendor-authored-assets\.mjs/);
assert.match(packageJson.scripts["vendor:authored:buildings"], /vendor-authored-buildings\.mjs/);
assert.match(packageJson.scripts["vendor:authored:characters"], /vendor-authored-characters\.mjs/);
assert.match(packageJson.scripts["build:web"], /vendor:authored:characters/);
assert.match(packageJson.scripts["build:web"], /validate-authored-buildings\.mjs/);
assert.match(packageJson.scripts["build:web"], /validate-authored-characters\.mjs/);
assert.match(packageJson.scripts["deploy:pbr-preview"], /wrangler\.pbr\.jsonc/);

assert.match(html, /type="importmap"/);
assert.match(html, /three\.module\.min\.js/);
assert.match(html, /style\.css\?v=0\.3\.11/);
assert.match(html, /boot\.js\?v=0\.3\.11/);
assert.doesNotMatch(html, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);

assert.match(boot, /VERSION\s*=\s*"0\.3\.11"/);
assert.match(boot, /WATCHDOG_MS\s*=\s*12_000/);
assert.match(boot, /import\(`\/client\/sky-fix\.js\?v=\$\{VERSION\}`\)/);
assert.ok(boot.indexOf("sky-fix.js") < boot.indexOf("moduleScript.src"));
assert.match(boot, /authored BOT/);
assert.match(boot, /PBR module graph failed to load/);

assert.match(skyFix, /WorldView\.prototype\.updateCamera/);
assert.match(skyFix, /sky\.position\.copy\(this\.camera\.position\)/);
assert.match(skyFix, /horizonGlow/);
assert.doesNotMatch(skyFix, /pow\(sunDot,\s*620/);
assert.match(skyFix, /material\.depthTest\s*=\s*false/);
assert.match(skyFix, /toneMappingExposure\s*=\s*0\.78/);
assert.match(skyFix, /moyoDecayStyled/);

assert.match(app, /createDemoState\(\)/);
assert.match(app, /loadHighResolutionModels/);
assert.match(app, /moyo:pbr-ready/);
assert.match(worldView, /createSkyDome/);
assert.match(worldView, /PCFShadowMap/);
assert.match(worldView, /RoomEnvironment/);
assert.match(resources, /authoredNature/);
assert.match(structures, /MoyoArchitecture/);

assert.match(modelLibrary, /MODEL_VERSION\s*=\s*"0\.3\.4"/);
assert.match(modelLibrary, /AUTHORED_VERSION\s*=\s*"0\.3\.7"/);
assert.match(modelLibrary, /AUTHORED_BUILDING_VERSION\s*=\s*"0\.3\.10"/);
assert.match(modelLibrary, /AUTHORED_CHARACTER_VERSION\s*=\s*"0\.3\.11"/);
assert.match(modelLibrary, /authored:building-camp/);
assert.match(modelLibrary, /authored:building-workshop/);
assert.match(modelLibrary, /authored:agent-worker/);
assert.match(modelLibrary, /authored:agent-roamer/);
assert.match(modelLibrary, /authored:tree-oak/);
assert.match(modelLibrary, /authored:rock-large/);
assert.match(modelLibrary, /SkeletonUtils\.js/);
assert.match(modelLibrary, /SkeletonUtils\.clone/);
assert.match(modelLibrary, /this\.animations\s*=\s*new Map/);
assert.match(modelLibrary, /clips\(name\)/);
assert.match(modelLibrary, /isAuthoredKey\(key\)\s*\?\s*Math\.max\(timeoutMs,\s*12_000\)/);
assert.doesNotMatch(modelLibrary, /Math\.min\(timeoutMs,\s*2_500\)/);
assert.ok(modelLibrary.indexOf('["settler"') < modelLibrary.indexOf('["authored:agent-worker"'));
assert.ok(modelLibrary.indexOf('["buildings"') < modelLibrary.indexOf('["authored:building-camp"'));

assert.match(agents, /AUTHORED_AGENT_BY_ROLE/);
assert.match(agents, /fitAuthoredAgent/);
assert.match(agents, /AnimationMixer/);
assert.match(agents, /walking\[_ -\]\?a/i);
assert.match(agents, /moyoAuthoredAgent/);
assert.match(agents, /disposeAgentEntry/);
assert.match(agents, /entry\.mixer\.update/);

assert.match(authoredVendor, /gitBlobSha/);
assert.match(authoredVendor, /MOYO_REQUIRE_AUTHORED_ASSETS/);
assert.match(authoredNotice, /Creative Commons CC0 1\.0/);
assert.equal(authoredManifest.version, "0.3.7");
assert.ok(Array.isArray(authoredManifest.loaded));
assert.ok(Array.isArray(authoredManifest.failed));
for (const asset of authoredManifest.loaded) {
  const data = await readFile(join("public/assets/authored/kenney", asset.file));
  assert.equal(data.toString("ascii", 0, 4), "glTF", `${asset.file} is not GLB`);
  assert.equal(data.readUInt32LE(4), 2, `${asset.file} is not glTF 2.0`);
  assert.equal(data.readUInt32LE(8), data.length, `${asset.file} length header is invalid`);
}

assert.equal(buildingManifest.version, "0.3.10");
assert.equal(buildingManifest.upstreamCommit, "84fa4e91af6a88989be7c99e0891cede11f2ca38");
assert.ok(Array.isArray(buildingManifest.loaded));
assert.ok(Array.isArray(buildingManifest.failed));
assert.match(buildingNotice, /Creative Commons Zero \(CC0\)/);

assert.equal(characterManifest.version, "0.3.11");
assert.equal(characterManifest.upstreamCommit, "672074b73ba276876a19e8816ecdc5241817ab47");
assert.ok(Array.isArray(characterManifest.loaded));
assert.ok(Array.isArray(characterManifest.failed));
assert.match(characterNotice, /Creative Commons Zero \(CC0\)/);
for (const asset of characterManifest.loaded) {
  const data = await readFile(join("public/assets/authored/kaykit-adventurers", asset.file));
  assert.equal(data.toString("ascii", 0, 4), "glTF", `${asset.file} is not GLB`);
  assert.equal(data.readUInt32LE(4), 2, `${asset.file} is not glTF 2.0`);
  assert.equal(data.readUInt32LE(8), data.length, `${asset.file} length header is invalid`);
  const jsonLength = data.readUInt32LE(12);
  const document = JSON.parse(data.toString("utf8", 20, 20 + jsonLength).trim());
  assert.ok(document.skins?.length > 0, `${asset.file} lacks skin`);
  assert.ok(document.animations?.length > 0, `${asset.file} lacks animations`);
}

const expectedNodes = {
  "settler.glb": ["SettlerRoot", "FactionTorso", "LeftLegPivot", "RightLegPivot"],
  "tree.glb": ["TreeRoot", "Trunk", "Foliage0"],
  "rock.glb": ["RockRoot", "Rock0"],
  "buildings.glb": ["BuildingsRoot", "Camp", "Storehouse", "Market", "Workshop"],
};
for (const [name, requiredNames] of Object.entries(expectedNodes)) {
  const data = await readFile(join("public/models", name));
  assert.equal(data.toString("ascii", 0, 4), "glTF", `${name} is not GLB`);
  assert.equal(data.readUInt32LE(4), 2, `${name} is not glTF 2.0`);
  assert.equal(data.readUInt32LE(8), data.length, `${name} length header is invalid`);
  const jsonLength = data.readUInt32LE(12);
  const document = JSON.parse(data.toString("utf8", 20, 20 + jsonLength).trim());
  assert.equal(document.asset.version, "2.0");
  assert.match(document.asset.generator, /procedural PBR texture baker/);
  assert.ok(document.materials.every((material) => material.pbrMetallicRoughness));
  assert.ok(document.images?.length > 0, `${name} lacks embedded PBR images`);
  assert.ok(document.materials.some((material) => material.normalTexture), `${name} lacks normal maps`);
  const names = new Set(document.nodes.map((node) => node.name));
  for (const expected of requiredNames) assert.ok(names.has(expected), `${name} lacks ${expected}`);
}

assert.equal(previewConfig.name, "moyo-garden-pbr-preview");
assert.equal(previewConfig.workers_dev, true);
assert.equal(previewConfig.preview_urls, false);
assert.ok(!("routes" in previewConfig), "preview must not claim the production custom domain");

console.log("Animated authored-agent/building/nature PBR preview validation passed");
