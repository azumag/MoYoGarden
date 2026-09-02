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
  "public/assets/authored/kenney/NOTICE.txt",
  "public/assets/authored/kenney/manifest.json",
  "public/vendor/three-r185/LICENSE",
  "public/vendor/three-r185/build/three.module.min.js",
  "public/vendor/three-r185/build/three.core.min.js",
  "public/vendor/three-r185/examples/jsm/loaders/GLTFLoader.js",
  "public/vendor/three-r185/examples/jsm/environments/RoomEnvironment.js",
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

assert.equal(packageJson.version, "0.3.9");
assert.equal(packageJson.dependencies.three, "0.185.1");
assert.match(packageJson.scripts["vendor:authored"], /vendor-authored-assets\.mjs/);
assert.match(packageJson.scripts["build:web"], /vendor:authored/);
assert.match(packageJson.scripts["build:web"], /vendor:three/);
assert.match(packageJson.scripts["deploy:pbr-preview"], /wrangler\.pbr\.jsonc/);

assert.match(html, /type="importmap"/);
assert.match(html, /three\.module\.min\.js/);
assert.match(html, /style\.css\?v=0\.3\.9/);
assert.match(html, /boot\.js\?v=0\.3\.9/);
assert.doesNotMatch(html, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);

assert.match(boot, /VERSION\s*=\s*"0\.3\.9"/);
assert.match(boot, /WATCHDOG_MS\s*=\s*12_000/);
assert.match(boot, /import\(`\/client\/sky-fix\.js\?v=\$\{VERSION\}`\)/);
assert.ok(
  boot.indexOf("sky-fix.js") < boot.indexOf("moduleScript.src"),
  "sky fix must be installed before the app module is launched",
);
assert.match(boot, /PBR module graph failed to load/);

assert.match(skyFix, /WorldView\.prototype\.updateCamera/);
assert.match(skyFix, /sky\.position\.copy\(this\.camera\.position\)/);
assert.match(skyFix, /horizonGlow/);
assert.doesNotMatch(skyFix, /pow\(sunDot,\s*620/);
assert.match(skyFix, /material\.depthTest\s*=\s*false/);
assert.match(skyFix, /material\.needsUpdate\s*=\s*true/);

assert.match(app, /createDemoState\(\)/);
assert.match(app, /loadHighResolutionModels/);
assert.match(app, /moyo:pbr-ready/);
assert.match(worldView, /createSkyDome/);
assert.match(worldView, /PCFShadowMap/);
assert.match(worldView, /RoomEnvironment/);
assert.match(resources, /authoredNature/);
assert.match(resources, /authoredTreeKey/);
assert.match(resources, /authoredRockKey/);
assert.match(structures, /MoyoArchitecture/);
assert.match(agents, /MoyoAgentSilhouette/);

assert.match(modelLibrary, /MODEL_VERSION\s*=\s*"0\.3\.4"/);
assert.match(modelLibrary, /AUTHORED_VERSION\s*=\s*"0\.3\.7"/);
assert.match(modelLibrary, /authored:tree-oak/);
assert.match(modelLibrary, /authored:tree-pine/);
assert.match(modelLibrary, /authored:rock-large/);
assert.match(modelLibrary, /Math\.min\(timeoutMs,\s*2_500\)/);
assert.ok(
  modelLibrary.indexOf('["settler"') < modelLibrary.indexOf('["authored:tree-oak"'),
  "core models must load before optional authored overrides",
);

assert.match(authoredVendor, /gitBlobSha/);
assert.match(authoredVendor, /MOYO_REQUIRE_AUTHORED_ASSETS/);
assert.match(authoredVendor, /Kenney Nature Kit/);
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

console.log("Orb-free authored PBR preview validation passed");
