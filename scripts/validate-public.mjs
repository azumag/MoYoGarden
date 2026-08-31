import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const clientModules = [
  "public/client/shared.js",
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
  "public/app.js",
  "public/style.css",
  ...clientModules,
  "public/models/settler.glb",
  "public/models/tree.glb",
  "public/models/rock.glb",
  "public/models/buildings.glb",
  "public/models/README.md",
  "public/vendor/three/LICENSE",
  "public/vendor/three/build/three.module.js",
  "public/vendor/three/build/three.core.js",
  "public/vendor/three/examples/jsm/loaders/GLTFLoader.js",
  "public/vendor/three/examples/jsm/environments/RoomEnvironment.js",
  "public/vendor/three/examples/jsm/utils/BufferGeometryUtils.js",
  "public/vendor/three/examples/jsm/utils/SkeletonUtils.js",
];
for (const path of required) {
  const info = await stat(path);
  assert.ok(info.isFile(), `${path} must be a file`);
  assert.ok(info.size > 100, `${path} is unexpectedly small`);
}

const html = await readFile("public/index.html", "utf8");
const sourceFiles = ["public/app.js", ...clientModules];
const sources = await Promise.all(sourceFiles.map((path) => readFile(path, "utf8")));
const script = sources.join("\n");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));

assert.equal(packageJson.version, "0.3.0");
assert.equal(packageJson.dependencies.three, "0.185.1", "Three.js must be exactly pinned");
assert.match(packageJson.scripts["build:web"], /generate:models/);
assert.match(packageJson.scripts["build:web"], /vendor:three/);
assert.match(packageJson.scripts["build:web"], /check:client/);
assert.match(html, /type="importmap"/);
assert.match(html, /"three"\s*:\s*"\/vendor\/three\/build\/three\.module\.js"/);
assert.match(html, /type="module" src="\/app\.js"/);
assert.doesNotMatch(html, /detail-upgrade\.js/);
assert.match(script, /GLTFLoader/);
assert.match(script, /parseAsync\(/);
assert.match(script, /AbortController/);
assert.match(script, /DEFAULT_MODEL_TIMEOUT_MS\s*=\s*7_000/);
assert.match(script, /quality"\)\s*===\s*"low"/);
assert.match(script, /\/models\/settler\.glb/);
assert.match(script, /MeshStandardMaterial/);
assert.match(script, /MeshPhysicalMaterial/);
assert.match(script, /new THREE\.LOD/);
assert.match(script, /shadowMap\.enabled\s*=\s*true/);
assert.match(script, /PCFSoftShadowMap/);
assert.match(script, /shadow\.mapSize\.set\(2048,\s*2048\)/);
assert.match(script, /addScaledVector\(right,\s*-dx\s*\*\s*amount\)/);
assert.match(script, /addScaledVector\(forward,\s*dy\s*\*\s*amount\)/);
assert.match(script, /RoomEnvironment/);
assert.match(script, /ACESFilmicToneMapping/);
assert.match(script, /SRGBColorSpace/);
assert.match(script, /createLod\(high,\s*medium,\s*low/);
assert.doesNotMatch(html, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);
assert.doesNotMatch(script, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);

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
  assert.equal(document.buffers.length, 1);
  assert.ok(document.buffers[0].byteLength <= binaryLength, `${name} buffer length exceeds BIN chunk`);
  assert.ok(document.materials.length > 0, `${name} lacks materials`);
  assert.ok(
    document.materials.every((material) => material.pbrMetallicRoughness),
    `${name} has a non-PBR material`,
  );
  assert.ok(document.meshes.length > 0, `${name} lacks meshes`);
  assert.ok(document.nodes.length > 0, `${name} lacks nodes`);
  assert.equal(document.buffers[0].uri, undefined, `${name} must be self-contained`);

  for (const view of document.bufferViews) {
    assert.ok(
      (view.byteOffset ?? 0) + view.byteLength <= document.buffers[0].byteLength,
      `${name} has an out-of-range bufferView`,
    );
  }
  for (const accessor of document.accessors) {
    assert.ok(
      Number.isInteger(accessor.bufferView)
        && accessor.bufferView >= 0
        && accessor.bufferView < document.bufferViews.length,
      `${name} has an invalid accessor`,
    );
    assert.ok(accessor.count > 0, `${name} has an empty accessor`);
  }
  const names = new Set(document.nodes.map((node) => node.name));
  for (const expected of expectedNodes[name]) {
    assert.ok(names.has(expected), `${name} lacks node ${expected}`);
  }
}

console.log("PBR/glTF/LOD/shadow client validation passed");
