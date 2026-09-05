import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "public/assets/authored/quaternius-buildings");
const UPSTREAM_REPO = "agentkaerf/FreeModels";
const UPSTREAM_COMMIT = "db3df04d1e4714298a09510b26fb6de6645138a2";
const SOURCE_ROOT = "Medieval Village MegaKit[Standard]/glTF";
const VERSION = "0.3.11-q2";
const REQUIRE = process.env.MOYO_REQUIRE_QUATERNIUS_BUILDINGS === "1";
const SKIP = process.env.MOYO_SKIP_QUATERNIUS_BUILDINGS === "1";

const SOURCES = Object.freeze({
  plaster: Object.freeze({
    gltf: "Wall_Plaster_Straight.gltf",
    bin: "Wall_Plaster_Straight.bin",
    gltfSha: "fb8b38f935a4ec0ef9f5069d153e52e796324da7",
    binSha: "55b39191caee09d6e2f2ea2d1525eb37671f4edf",
  }),
  door: Object.freeze({
    gltf: "Wall_Plaster_Door_Flat.gltf",
    bin: "Wall_Plaster_Door_Flat.bin",
    gltfSha: "4f95061ce04ac690633743460137e6d8df0d6295",
    binSha: "7124e32b16aafab919e7d40bdb3d0990d0473750",
  }),
  window: Object.freeze({
    gltf: "Wall_Plaster_Window_Wide_Flat.gltf",
    bin: "Wall_Plaster_Window_Wide_Flat.bin",
    gltfSha: "e71f5e5bd9361193dd3ff9cf348511f1b1042198",
    binSha: "f5aa010191394fcb249f3ebc91a58ac8488e6e26",
  }),
  brick: Object.freeze({
    gltf: "Wall_UnevenBrick_Straight.gltf",
    bin: "Wall_UnevenBrick_Straight.bin",
    gltfSha: "5b88693146ead7822091c7cb8fbe4639a8d7f25f",
    binSha: "e81f1781287b137ab2ea1a57cedd979f28f0f3fc",
  }),
  roof: Object.freeze({
    gltf: "Roof_Wooden_2x1.gltf",
    bin: "Roof_Wooden_2x1.bin",
    gltfSha: "fb79d2c41ec84d5bc3b994fd37100f3bd9380bff",
    binSha: "cc94d9b8451bb2ac2e252af33ada7e38d55e6047",
  }),
});

const MATERIALS = Object.freeze([
  Object.freeze({ name: "MoyoShell_Wood", color: [0.18, 0.125, 0.085, 1], roughness: 0.98 }),
  Object.freeze({ name: "MoyoShell_Plaster", color: [0.37, 0.35, 0.30, 1], roughness: 0.97 }),
  Object.freeze({ name: "MoyoShell_Brick", color: [0.29, 0.225, 0.17, 1], roughness: 0.985 }),
  Object.freeze({ name: "MoyoShell_Stone", color: [0.31, 0.305, 0.275, 1], roughness: 0.99 }),
  Object.freeze({ name: "MoyoShell_WornWood", color: [0.135, 0.105, 0.078, 1], roughness: 1 }),
]);

const BUILDINGS = Object.freeze([
  Object.freeze({
    key: "authored:building-shell-camp",
    file: "camp.glb",
    parts: Object.freeze([
      ["door", 0, 0, 1.15, 0],
      ["plaster", 0, 0, -1.15, Math.PI],
      ["plaster", -1.0, 0, 0, -Math.PI / 2, 1.16],
      ["window", 1.0, 0, 0, Math.PI / 2, 1.16],
      ["roof", 0, 3.0, 0, 0, 1.02],
      ["roof", 0, 3.0, 0, Math.PI, 1.02],
    ]),
  }),
  Object.freeze({
    key: "authored:building-shell-storehouse",
    file: "storehouse.glb",
    parts: Object.freeze([
      ["door", -1.0, 0, 1.25, 0],
      ["window", 1.0, 0, 1.25, 0],
      ["brick", -1.0, 0, -1.25, Math.PI],
      ["plaster", 1.0, 0, -1.25, Math.PI],
      ["brick", -2.0, 0, 0, -Math.PI / 2, 1.25],
      ["plaster", 2.0, 0, 0, Math.PI / 2, 1.25],
      ["roof", -1.0, 3.0, 0, 0, 1.04],
      ["roof", -1.0, 3.0, 0, Math.PI, 1.04],
      ["roof", 1.0, 3.0, 0, 0, 1.04],
      ["roof", 1.0, 3.0, 0, Math.PI, 1.04],
    ]),
  }),
  Object.freeze({
    key: "authored:building-shell-market",
    file: "market.glb",
    parts: Object.freeze([
      ["door", -1.0, 0, 1.4, 0],
      ["door", 1.0, 0, 1.4, 0],
      ["window", -1.0, 0, -1.4, Math.PI],
      ["plaster", 1.0, 0, -1.4, Math.PI],
      ["plaster", -2.0, 0, 0, -Math.PI / 2, 1.38],
      ["window", 2.0, 0, 0, Math.PI / 2, 1.38],
      ["roof", -1.0, 3.0, 0, 0, 1.12],
      ["roof", -1.0, 3.0, 0, Math.PI, 1.12],
      ["roof", 1.0, 3.0, 0, 0, 1.12],
      ["roof", 1.0, 3.0, 0, Math.PI, 1.12],
    ]),
  }),
  Object.freeze({
    key: "authored:building-shell-workshop",
    file: "workshop.glb",
    parts: Object.freeze([
      ["door", -1.0, 0, 1.25, 0],
      ["brick", 1.0, 0, 1.25, 0],
      ["brick", -1.0, 0, -1.25, Math.PI],
      ["brick", 1.0, 0, -1.25, Math.PI],
      ["window", -2.0, 0, 0, -Math.PI / 2, 1.25],
      ["brick", 2.0, 0, 0, Math.PI / 2, 1.25],
      ["roof", -1.0, 3.0, 0, 0, 1.04],
      ["roof", -1.0, 3.0, 0, Math.PI, 1.04],
      ["roof", 1.0, 3.0, 0, 0, 1.04],
      ["roof", 1.0, 3.0, 0, Math.PI, 1.04],
    ]),
  }),
]);

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function sourceUrl(file) {
  const path = `${SOURCE_ROOT}/${file}`
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_COMMIT}/${path}`;
}

async function fetchPinned(file, expectedSha) {
  const response = await fetch(sourceUrl(file), {
    signal: AbortSignal.timeout(20_000),
    headers: { "user-agent": "MoYoGarden-build" },
  });
  if (!response.ok) throw new Error(`${file} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha = gitBlobSha(bytes);
  if (actualSha !== expectedSha) {
    throw new Error(`${file} blob SHA mismatch: expected ${expectedSha}, got ${actualSha}`);
  }
  return bytes;
}

function pad4(bytes, fill = 0) {
  const padding = (4 - (bytes.length % 4)) % 4;
  return padding === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(padding, fill)]);
}

function packGlb(document, binary) {
  const json = pad4(Buffer.from(JSON.stringify(document)), 0x20);
  const bin = pad4(binary, 0x00);
  const totalLength = 12 + 8 + json.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, bin]);
}

function materialIndex(name = "") {
  const lower = name.toLowerCase();
  if (lower.includes("wear")) return 4;
  if (lower.includes("wood")) return 0;
  if (lower.includes("plaster")) return 1;
  if (lower.includes("brick")) return 2;
  if (lower.includes("rock") || lower.includes("stone")) return 3;
  return 1;
}

function outputMaterials() {
  return MATERIALS.map((material) => ({
    name: material.name,
    doubleSided: true,
    pbrMetallicRoughness: {
      baseColorFactor: material.color,
      metallicFactor: 0,
      roughnessFactor: material.roughness,
    },
  }));
}

function prepareSource(source, spec, binary) {
  if (!Array.isArray(source.buffers) || source.buffers.length !== 1) {
    throw new Error(`${spec.gltf} must contain exactly one buffer`);
  }
  if (source.buffers[0].uri !== spec.bin || source.buffers[0].byteLength !== binary.length) {
    throw new Error(`${spec.gltf} references an unexpected binary buffer`);
  }
  if (!source.meshes?.length) throw new Error(`${spec.gltf} lacks meshes`);

  delete source.images;
  delete source.textures;
  delete source.samplers;

  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const mesh of source.meshes) {
    for (const primitive of mesh.primitives || []) {
      const positionAccessor = source.accessors?.[primitive.attributes?.POSITION];
      if (!positionAccessor?.min || !positionAccessor?.max) {
        throw new Error(`${spec.gltf} POSITION accessor lacks min/max bounds`);
      }
      for (let axis = 0; axis < 3; axis += 1) {
        bounds[axis] = Math.min(bounds[axis], positionAccessor.min[axis]);
        bounds[axis + 3] = Math.max(bounds[axis + 3], positionAccessor.max[axis]);
      }
    }
  }
  return { source, binary, bounds };
}

async function loadSources() {
  const entries = await Promise.all(Object.entries(SOURCES).map(async ([name, spec]) => {
    const [gltfBytes, binBytes] = await Promise.all([
      fetchPinned(spec.gltf, spec.gltfSha),
      fetchPinned(spec.bin, spec.binSha),
    ]);
    const source = JSON.parse(gltfBytes.toString("utf8"));
    return [name, prepareSource(source, spec, binBytes)];
  }));
  return new Map(entries);
}

function appendSource(target, prepared) {
  const { source, binary } = prepared;
  const binaryOffset = target.binary.length;
  target.binary = Buffer.concat([target.binary, pad4(binary)]);
  const bufferViewBase = target.bufferViews.length;
  for (const view of source.bufferViews || []) {
    target.bufferViews.push({
      ...structuredClone(view),
      buffer: 0,
      byteOffset: binaryOffset + (view.byteOffset || 0),
    });
  }
  const accessorBase = target.accessors.length;
  for (const accessor of source.accessors || []) {
    const clone = structuredClone(accessor);
    if (Number.isInteger(clone.bufferView)) clone.bufferView += bufferViewBase;
    target.accessors.push(clone);
  }
  const meshBase = target.meshes.length;
  for (const mesh of source.meshes || []) {
    const clone = structuredClone(mesh);
    clone.primitives = (clone.primitives || []).map((primitive) => {
      const next = structuredClone(primitive);
      next.attributes = Object.fromEntries(Object.entries(next.attributes || {}).map(
        ([attribute, index]) => [attribute, index + accessorBase],
      ));
      if (Number.isInteger(next.indices)) next.indices += accessorBase;
      if (Number.isInteger(next.material)) {
        next.material = materialIndex(source.materials?.[next.material]?.name);
      }
      if (Array.isArray(next.targets)) {
        next.targets = next.targets.map((targetAttributes) => Object.fromEntries(
          Object.entries(targetAttributes).map(([attribute, index]) => [attribute, index + accessorBase]),
        ));
      }
      return next;
    });
    target.meshes.push(clone);
  }
  return meshBase;
}

function yQuaternion(angle) {
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}

function transformPoint(point, translation, angle, scale) {
  const x = point[0] * scale[0];
  const y = point[1] * scale[1];
  const z = point[2] * scale[2];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    x * c + z * s + translation[0],
    y + translation[1],
    -x * s + z * c + translation[2],
  ];
}

function includePartBounds(bounds, sourceBounds, translation, angle, scale) {
  const [minX, minY, minZ, maxX, maxY, maxZ] = sourceBounds;
  for (const x of [minX, maxX]) {
    for (const y of [minY, maxY]) {
      for (const z of [minZ, maxZ]) {
        const point = transformPoint([x, y, z], translation, angle, scale);
        for (let axis = 0; axis < 3; axis += 1) {
          bounds[axis] = Math.min(bounds[axis], point[axis]);
          bounds[axis + 3] = Math.max(bounds[axis + 3], point[axis]);
        }
      }
    }
  }
}

function createShellDocument(building, sources) {
  const target = {
    binary: Buffer.alloc(0),
    bufferViews: [],
    accessors: [],
    meshes: [],
    meshIndex: new Map(),
  };
  for (const [name, prepared] of sources) {
    target.meshIndex.set(name, appendSource(target, prepared));
  }

  const nodes = [];
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const [sourceName, x, y, z, angle = 0, horizontalScale = 1] of building.parts) {
    const prepared = sources.get(sourceName);
    if (!prepared) throw new Error(`${building.file} references unknown source ${sourceName}`);
    const scale = [horizontalScale, 1, horizontalScale];
    const translation = [x, y, z];
    nodes.push({
      name: `${building.key}:${sourceName}:${nodes.length}`,
      mesh: target.meshIndex.get(sourceName),
      translation,
      rotation: yQuaternion(angle),
      scale,
    });
    includePartBounds(bounds, prepared.bounds, translation, angle, scale);
  }

  if (!bounds.every(Number.isFinite)) throw new Error(`${building.file} has invalid aggregate bounds`);
  const groundOffset = -bounds[1];
  for (const node of nodes) node.translation[1] += groundOffset;
  const groundedBounds = {
    minX: bounds[0],
    minY: 0,
    minZ: bounds[2],
    maxX: bounds[3],
    maxY: bounds[4] + groundOffset,
    maxZ: bounds[5],
  };

  const document = {
    asset: {
      version: "2.0",
      generator: `MoYoGarden Quaternius shell vendor ${VERSION}`,
      extras: { sourceLicense: "CC0-1.0", upstreamCommit: UPSTREAM_COMMIT },
    },
    scene: 0,
    scenes: [{ name: building.key, nodes: nodes.map((_, index) => index) }],
    nodes,
    materials: outputMaterials(),
    meshes: target.meshes,
    accessors: target.accessors,
    bufferViews: target.bufferViews,
    buffers: [{ byteLength: target.binary.length }],
    extras: { moyoBounds: groundedBounds },
  };
  return { document, binary: target.binary, bounds: groundedBounds };
}

function validatePackedGlb(bytes, building, bounds) {
  if (bytes.length < 28 || bytes.toString("ascii", 0, 4) !== "glTF") {
    throw new Error(`${building.file} is not a GLB file`);
  }
  if (bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${building.file} has an invalid GLB header`);
  }
  if (bytes.length > 256 * 1024) {
    throw new Error(`${building.file} is unexpectedly large (${bytes.length} bytes)`);
  }
  if (Math.abs(bounds.minY) > 0.0001 || bounds.maxY <= 0.5) {
    throw new Error(`${building.file} is not grounded correctly`);
  }
}

async function buildShell(building, sources) {
  const { document, binary, bounds } = createShellDocument(building, sources);
  const packed = packGlb(document, binary);
  validatePackedGlb(packed, building, bounds);
  await writeFile(resolve(OUT, building.file), packed);
  return { key: building.key, file: building.file, bytes: packed.length, bounds };
}

await mkdir(OUT, { recursive: true });
const loaded = [];
const failed = [];
let sources = null;

if (!SKIP) {
  try {
    sources = await loadSources();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const building of BUILDINGS) failed.push({ key: building.key, file: building.file, message });
    console.warn("MoYoGarden: optional Quaternius building sources unavailable", error);
  }
}

if (sources) {
  for (const building of BUILDINGS) {
    try {
      const result = await buildShell(building, sources);
      loaded.push(result);
      console.log(`Quaternius building shell: ${building.file} (${result.bytes} bytes)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ key: building.key, file: building.file, message });
      console.warn(`MoYoGarden: optional Quaternius building shell ${building.file} unavailable`, error);
    }
  }
} else if (SKIP) {
  for (const building of BUILDINGS) {
    failed.push({ key: building.key, file: building.file, message: "skipped by build flag" });
  }
}

const notice = [
  "MoYoGarden authored Quaternius building shell cache",
  `version: ${VERSION}`,
  "",
  "Selected modular geometry originates from Quaternius Medieval Village MegaKit Standard.",
  "License: Creative Commons CC0 1.0 Universal / Public Domain Dedication.",
  "Official source: https://quaternius.com",
  `Pinned mirror: https://github.com/${UPSTREAM_REPO}/tree/${UPSTREAM_COMMIT}`,
  "",
  "Only geometry is retained. Upstream texture/image/sampler references are removed.",
  "MoYoGarden composes four exterior shells and supplies its own muted PBR material factors.",
  "",
  ...Object.values(SOURCES).map((spec) => `${spec.gltf} + ${spec.bin} | ${spec.gltfSha} / ${spec.binSha}`),
  "",
].join("\n");

await writeFile(resolve(OUT, "NOTICE.txt"), notice);
await writeFile(resolve(OUT, "manifest.json"), JSON.stringify({
  version: VERSION,
  upstreamRepo: UPSTREAM_REPO,
  upstreamCommit: UPSTREAM_COMMIT,
  license: "CC0-1.0",
  sources: Object.values(SOURCES),
  loaded,
  failed,
}, null, 2));

if (failed.length > 0) {
  console.warn(`MoYoGarden: ${failed.length}/${BUILDINGS.length} Quaternius building shells unavailable; KayKit fallbacks remain enabled`);
  if (REQUIRE) throw new Error("Required Quaternius building shells could not be vendored");
}
