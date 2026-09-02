import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const applicationModules = [
  "public/boot.js",
  "public/app.js",
  "public/client/shared.js",
  "public/client/quality.js",
  "public/client/model-library.js",
  "public/client/terrain.js",
  "public/client/resources.js",
  "public/client/structures.js",
  "public/client/agents.js",
  "public/client/world-view.js",
  "public/client/demo-state.js",
];
const required = [
  "public/index.html",
  "public/style.css",
  ...applicationModules,
  "public/models/settler.glb",
  "public/models/tree.glb",
  "public/models/rock.glb",
  "public/models/buildings.glb",
  "public/models/README.md",
  "public/vendor/three-r185/LICENSE",
  "public/vendor/three-r185/build/three.module.min.js",
  "public/vendor/three-r185/build/three.core.min.js",
  "public/vendor/three-r185/examples/jsm/loaders/GLTFLoader.js",
  "public/vendor/three-r185/examples/jsm/environments/RoomEnvironment.js",
  "public/vendor/three-r185/examples/jsm/utils/BufferGeometryUtils.js",
  "public/vendor/three-r185/examples/jsm/utils/SkeletonUtils.js",
];
for (const path of required) {
  const info = await stat(path);
  assert.ok(info.isFile(), `${path} must be a file`);
  assert.ok(info.size > 100, `${path} is unexpectedly small`);
}

const html = await readFile("public/index.html", "utf8");
const boot = await readFile("public/boot.js", "utf8");
const app = await readFile("public/app.js", "utf8");
const modelLibrary = await readFile("public/client/model-library.js", "utf8");
const worldView = await readFile("public/client/world-view.js", "utf8");
const terrain = await readFile("public/client/terrain.js", "utf8");
const resources = await readFile("public/client/resources.js", "utf8");
const structures = await readFile("public/client/structures.js", "utf8");
const shared = await readFile("public/client/shared.js", "utf8");
const quality = await readFile("public/client/quality.js", "utf8");
const enhancer = await readFile("scripts/enhance-models.mjs", "utf8");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const previewConfig = JSON.parse(await readFile("wrangler.pbr.jsonc", "utf8"));
const combined = [boot, app, modelLibrary, worldView, terrain, resources, structures, shared, quality].join("\n");

assert.equal(packageJson.version, "0.3.5");
assert.equal(packageJson.dependencies.three, "0.185.1", "Three.js must be exactly pinned");
assert.match(packageJson.scripts["generate:models"], /enhance-models\.mjs/);
assert.match(packageJson.scripts["build:web"], /generate:models/);
assert.match(packageJson.scripts["build:web"], /vendor:three/);
assert.match(packageJson.scripts["build:web"], /check:client/);
assert.match(packageJson.scripts["deploy:pbr-preview"], /wrangler\.pbr\.jsonc/);

assert.match(html, /type="importmap"/);
assert.match(html, /"three"\s*:\s*"\/vendor\/three-r185\/build\/three\.module\.min\.js"/);
assert.match(html, /src="\/boot\.js\?v=0\.3\.5"/);
assert.match(html, /style\.css\?v=0\.3\.5/);
assert.doesNotMatch(html, /type="module"\s+src="\/app\.js/);
assert.match(html, /id="render-status"/);
assert.match(html, /id="loading-progress"/);

assert.match(boot, /VERSION\s*=\s*"0\.3\.5"/);
assert.match(boot, /WATCHDOG_MS\s*=\s*12_000/);
assert.match(boot, /moyo:pbr-ready/);
assert.match(boot, /moyo:pbr-error/);
assert.match(boot, /renderer"\)\s*===\s*"compat"/);
assert.match(boot, /quality"\)\s*===\s*"low"/);
assert.match(boot, /PBR module graph failed to load/);
assert.match(boot, /moyo\.bluemoon\.works/);

assert.match(app, /createDemoState\(\)/);
assert.match(app, /moyo:pbr-ready/);
assert.match(app, /view\.startEnhancements\(\)/);
assert.match(app, /loadHighResolutionModels/);
assert.match(app, /applyEnvelope\(\{ state: createDemoState\(\)/);
assert.match(app, /setTimeout\(\(\) => \{ void loadHighResolutionModels\(\); \}, 80\)/);

// Generated GLB assets have not changed in 0.3.5, so their independent cache version remains 0.3.4.
assert.match(modelLibrary, /MODEL_VERSION\s*=\s*"0\.3\.4"/);
assert.match(modelLibrary, /import\("three\/addons\/loaders\/GLTFLoader\.js"\)/);
assert.doesNotMatch(modelLibrary, /^import .*GLTFLoader/m);
assert.match(modelLibrary, /AbortController/);
assert.match(modelLibrary, /Promise\.race/);
assert.match(modelLibrary, /concurrency/);
assert.match(modelLibrary, /validateGlb/);
assert.match(modelLibrary, /moyoShared/);
assert.match(modelLibrary, /mutedFaction/);
assert.match(modelLibrary, /\/models\/settler\.glb\?v=/);

assert.match(worldView, /import\("three\/addons\/environments\/RoomEnvironment\.js"\)/);
assert.doesNotMatch(worldView, /^import .*RoomEnvironment/m);
assert.match(worldView, /toneMappingExposure\s*=\s*1\.08/);
assert.match(worldView, /createSkyDome/);
assert.match(worldView, /ShaderMaterial/);
assert.match(worldView, /sunDirection/);
assert.match(worldView, /AmbientLight/);
assert.match(worldView, /shadowMap\.autoUpdate\s*=\s*false/);
assert.match(worldView, /PCFShadowMap/);
assert.match(worldView, /startEnhancements/);
assert.match(worldView, /refreshModelType/);
assert.match(worldView, /addScaledVector\(right,\s*-dx\s*\*\s*amount\)/);
assert.match(worldView, /addScaledVector\(forward,\s*dy\s*\*\s*amount\)/);
assert.match(worldView, /environmentSize/);

assert.match(terrain, /MeshPhysicalMaterial/);
assert.match(terrain, /transmission:\s*0/);
assert.match(terrain, /cornerHeight/);
assert.match(terrain, /quadNormal/);
assert.match(terrain, /shorelineMaterial/);
assert.match(terrain, /CircleGeometry\(radius/);
assert.match(terrain, /pathMaterial/);

assert.match(resources, /shouldRenderResource/);
assert.match(resources, /isSettlementClearing/);
assert.match(resources, /object\.name\.startsWith\("Foliage"\)/);
assert.match(resources, /entry\.lod\.scale\.set\(/);
assert.match(resources, /style\s*=\s*Math\.floor\(hash2/);
assert.match(structures, /const base = structure\.type === "camp"/);
assert.match(shared, /moyoShared/);
assert.match(quality, /balanced/);
assert.match(quality, /ultra/);
assert.match(quality, /pixelRatioCap/);

assert.match(enhancer, /encodePng/);
assert.match(enhancer, /TEXCOORD_0/);
assert.match(enhancer, /baseColorTexture/);
assert.match(enhancer, /metallicRoughnessTexture/);
assert.match(enhancer, /normalTexture/);
assert.match(enhancer, /procedural PBR texture baker/);

assert.equal(previewConfig.name, "moyo-garden-pbr-preview");
assert.equal(previewConfig.workers_dev, true);
assert.equal(previewConfig.preview_urls, false);
assert.ok(!("routes" in previewConfig), "PBR preview must not claim the production custom domain");

assert.doesNotMatch(html, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);
assert.doesNotMatch(combined, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);

const expectedNodes = {
  "settler.glb": [
    "SettlerRoot", "FactionTorso", "LeftLegPivot", "RightLegPivot",
    "Role_builder_Head", "Role_miner_Head",
  ],
  "tree.glb": ["TreeRoot", "Trunk", "Foliage0"],
  "rock.glb": ["RockRoot", "Rock0", "detail_OreVein"],
  "buildings.glb": ["BuildingsRoot", "Camp", "Storehouse", "Market", "Workshop"],
};
for (const name of Object.keys(expectedNodes)) {
  const data = await readFile(join("public/models", name));
  assert.equal(data.toString("ascii", 0, 4), "glTF", `${name} is not GLB`);
  assert.equal(data.readUInt32LE(4), 2, `${name} is not glTF 2.0`);
  assert.equal(data.readUInt32LE(8), data.length, `${name} length header is invalid`);
  const jsonLength = data.readUInt32LE(12);
  assert.equal(data.toString("ascii", 16, 20), "JSON", `${name} lacks a JSON chunk`);
  const document = JSON.parse(data.toString("utf8", 20, 20 + jsonLength).trim());
  const binaryHeaderOffset = 20 + jsonLength;
  const binaryLength = data.readUInt32LE(binaryHeaderOffset);
  assert.equal(data.readUInt32LE(binaryHeaderOffset + 4), 0x004e4942, `${name} lacks a BIN chunk`);
  assert.equal(binaryHeaderOffset + 8 + binaryLength, data.length, `${name} BIN chunk length is invalid`);
  assert.equal(document.asset.version, "2.0");
  assert.match(document.asset.generator, /procedural PBR texture baker/);
  assert.ok(document.materials.every((material) => material.pbrMetallicRoughness));
  assert.ok(document.images?.length > 0, `${name} lacks embedded PBR images`);
  assert.ok(document.textures?.length > 0, `${name} lacks embedded PBR textures`);
  assert.ok(
    document.materials.some((material) => material.pbrMetallicRoughness.baseColorTexture),
    `${name} lacks base-color textures`,
  );
  assert.ok(document.materials.some((material) => material.normalTexture), `${name} lacks normal maps`);
  for (const mesh of document.meshes) {
    for (const primitive of mesh.primitives) {
      assert.ok(Number.isInteger(primitive.attributes.TEXCOORD_0), `${name} mesh lacks TEXCOORD_0`);
    }
  }
  assert.equal(document.buffers[0].uri, undefined, `${name} must be self-contained`);
  const names = new Set(document.nodes.map((node) => node.name));
  for (const expected of expectedNodes[name]) assert.ok(names.has(expected), `${name} lacks ${expected}`);
}

console.log("Atmospheric textured PBR/glTF/LOD/shadow preview validation passed");
