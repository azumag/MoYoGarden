import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "public/assets/authored/quaternius-decay");
const UPSTREAM_REPO = "agentkaerf/FreeModels";
const UPSTREAM_COMMIT = "db3df04d1e4714298a09510b26fb6de6645138a2";
const SOURCE_ROOT = "Medieval Village MegaKit[Standard]/glTF";
const VERSION = "0.3.11-q1";
const REQUIRE = process.env.MOYO_REQUIRE_QUATERNIUS_DECAY === "1";
const SKIP = process.env.MOYO_SKIP_QUATERNIUS_DECAY === "1";

const ASSETS = Object.freeze([
  Object.freeze({
    key: "authored:decay-rubble",
    file: "rubble.glb",
    sourceGltf: "Prop_Brick1.gltf",
    sourceBin: "Prop_Brick1.bin",
    gltfSha: "6bdecc7eafe57a0bd157d9bb8f3f0d1437a9859a",
    binSha: "d1e12c5ed0d53c1c0836617c12174f5970481862",
    baseColor: [0.30, 0.29, 0.26, 1],
    roughness: 0.98,
    metalness: 0.01,
  }),
  Object.freeze({
    key: "authored:decay-support",
    file: "support.glb",
    sourceGltf: "Prop_Support.gltf",
    sourceBin: "Prop_Support.bin",
    gltfSha: "d3347140c5181823eb1a93384c058f62921e30e4",
    binSha: "a3c6ca8800121ff3ede2d5ed6e3c2fd844ab5696",
    baseColor: [0.22, 0.16, 0.12, 1],
    roughness: 0.98,
    metalness: 0,
  }),
  Object.freeze({
    key: "authored:decay-fence",
    file: "fence.glb",
    sourceGltf: "Prop_WoodenFence_Single.gltf",
    sourceBin: "Prop_WoodenFence_Single.bin",
    gltfSha: "72f2b5e220aaba56b358b764fbf380bcdaedb70d",
    binSha: "596969ab7c6fe624b16223681fc932b5cdeed07e",
    baseColor: [0.25, 0.18, 0.13, 1],
    roughness: 0.98,
    metalness: 0,
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
  const url = sourceUrl(file);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { "user-agent": "MoYoGarden-build" },
  });
  if (!response.ok) throw new Error(`${file} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha = gitBlobSha(bytes);
  if (actualSha !== expectedSha) {
    throw new Error(`${file} blob SHA mismatch: expected ${expectedSha}, got ${actualSha}`);
  }
  return { bytes, url };
}

function pad4(bytes, fill) {
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

function rewriteDocument(source, asset, binaryLength) {
  const document = structuredClone(source);
  if (!Array.isArray(document.buffers) || document.buffers.length !== 1) {
    throw new Error(`${asset.sourceGltf} must contain exactly one buffer`);
  }
  if (document.buffers[0].uri !== asset.sourceBin) {
    throw new Error(`${asset.sourceGltf} references unexpected buffer ${document.buffers[0].uri}`);
  }

  document.buffers = [{ byteLength: binaryLength }];
  delete document.images;
  delete document.textures;
  delete document.samplers;
  document.materials = (document.materials?.length ? document.materials : [{}]).map((_, index) => ({
    name: `MoYoDecay_${asset.key.replaceAll(":", "_")}_${index}`,
    doubleSided: true,
    pbrMetallicRoughness: {
      baseColorFactor: asset.baseColor,
      metallicFactor: asset.metalness,
      roughnessFactor: asset.roughness,
    },
  }));
  return document;
}

function validatePackedGlb(bytes, asset) {
  if (bytes.length < 28 || bytes.toString("ascii", 0, 4) !== "glTF") {
    throw new Error(`${asset.file} is not a GLB file`);
  }
  if (bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${asset.file} has an invalid GLB header`);
  }
  if (bytes.length > 256 * 1024) {
    throw new Error(`${asset.file} is unexpectedly large (${bytes.length} bytes)`);
  }
}

async function convertAsset(asset) {
  const [gltf, binary] = await Promise.all([
    fetchPinned(asset.sourceGltf, asset.gltfSha),
    fetchPinned(asset.sourceBin, asset.binSha),
  ]);
  const source = JSON.parse(gltf.bytes.toString("utf8"));
  const document = rewriteDocument(source, asset, binary.bytes.length);
  const packed = packGlb(document, binary.bytes);
  validatePackedGlb(packed, asset);
  await writeFile(resolve(OUT, asset.file), packed);
  return {
    key: asset.key,
    file: asset.file,
    bytes: packed.length,
    sourceGltf: asset.sourceGltf,
    sourceBin: asset.sourceBin,
    gltfSha: asset.gltfSha,
    binSha: asset.binSha,
    sourceUrl: gltf.url,
  };
}

await mkdir(OUT, { recursive: true });
const loaded = [];
const failed = [];

if (!SKIP) {
  for (const asset of ASSETS) {
    try {
      const result = await convertAsset(asset);
      loaded.push(result);
      console.log(`Quaternius decay asset: ${asset.file} (${result.bytes} bytes)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ key: asset.key, file: asset.file, message });
      console.warn(`MoYoGarden: optional Quaternius decay asset ${asset.file} unavailable`, error);
    }
  }
}

const notice = [
  "MoYoGarden authored decay asset cache",
  `version: ${VERSION}`,
  "",
  "Selected geometry originates from Quaternius Medieval Village MegaKit Standard.",
  "License: Creative Commons CC0 1.0 Universal / Public Domain Dedication.",
  "Official source: https://quaternius.com",
  `Pinned mirror: https://github.com/${UPSTREAM_REPO}/tree/${UPSTREAM_COMMIT}`,
  "",
  "Only geometry is retained. Upstream texture/image/sampler references are removed and",
  "MoYoGarden supplies its own muted PBR material factors before packing self-contained GLBs.",
  "",
  ...ASSETS.map((asset) => `${asset.file} | ${asset.sourceGltf} + ${asset.sourceBin} | CC0-1.0 | ${asset.gltfSha} / ${asset.binSha}`),
  "",
].join("\n");

await writeFile(resolve(OUT, "NOTICE.txt"), notice);
await writeFile(resolve(OUT, "manifest.json"), JSON.stringify({
  version: VERSION,
  upstreamRepo: UPSTREAM_REPO,
  upstreamCommit: UPSTREAM_COMMIT,
  license: "CC0-1.0",
  loaded,
  failed,
}, null, 2));

if (failed.length > 0) {
  console.warn(`MoYoGarden: ${failed.length}/${ASSETS.length} Quaternius decay assets unavailable; procedural fallbacks remain enabled`);
  if (REQUIRE) throw new Error("Required Quaternius decay assets could not be vendored");
}
