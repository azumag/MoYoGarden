import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "public/assets/authored/kaykit");
const UPSTREAM_REPO = "KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0";
const UPSTREAM_COMMIT = "84fa4e91af6a88989be7c99e0891cede11f2ca38";
const SOURCE_ROOT = "addons/kaykit_medieval_hexagon_pack/Assets/gltf/buildings/red";
const VERSION = "0.3.10";
const REQUIRE = process.env.MOYO_REQUIRE_AUTHORED_ASSETS === "1";
const SKIP = process.env.MOYO_SKIP_AUTHORED_ASSETS === "1";
const TEXTURE = Object.freeze({
  file: "hexagons_medieval.png",
  gitBlobSha: "14cdc253646e4dba3cb7a267a6f7399b78ba2231",
});

const ASSETS = Object.freeze([
  {
    key: "authored:building-camp",
    file: "camp.glb",
    sourceBase: "building_home_A_red",
    gltfSha: "853afb548b9d9271d8d96408fc15e99042411585",
    binSha: "5e6f88335623b733645b3ace23f3b4d9a6339d5a",
    original: "KayKit Medieval Hexagon Pack 1.0 / Home A",
  },
  {
    key: "authored:building-storehouse",
    file: "storehouse.glb",
    sourceBase: "building_lumbermill_red",
    gltfSha: "b7b832d1e466bad153c8d8ee827a1790c76fc5e4",
    binSha: "cbd901016f16b89345699a447fe3463c89bbc368",
    original: "KayKit Medieval Hexagon Pack 1.0 / Lumbermill",
  },
  {
    key: "authored:building-market",
    file: "market.glb",
    sourceBase: "building_market_red",
    gltfSha: "7c9a573ecfb49ddaff4a292fb9f010949591f891",
    binSha: "db197fa61dcbac1c75862c251cd4f2bbd2a7c170",
    original: "KayKit Medieval Hexagon Pack 1.0 / Market",
  },
  {
    key: "authored:building-workshop",
    file: "workshop.glb",
    sourceBase: "building_blacksmith_red",
    gltfSha: "230d04dc40acfdfded49b92dcfe141a5ec17aea0",
    binSha: "e025905f1d6445df3aea9f3e0c1b07bf31866901",
    original: "KayKit Medieval Hexagon Pack 1.0 / Blacksmith",
  },
]);

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function assertBlob(bytes, expected, label) {
  const actual = gitBlobSha(bytes);
  if (actual !== expected) throw new Error(`${label} blob SHA mismatch: ${actual}`);
}

function pad(buffer, fill = 0) {
  const count = (4 - (buffer.length % 4)) % 4;
  return count ? Buffer.concat([buffer, Buffer.alloc(count, fill)]) : buffer;
}

async function fetchPinned(path, expectedSha) {
  const url = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_COMMIT}/${path}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "MoYoGarden-build" },
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assertBlob(bytes, expectedSha, path);
  return { bytes, url };
}

function buildGlb(gltfBytes, binBytes, textureBytes, asset) {
  const document = JSON.parse(gltfBytes.toString("utf8"));
  if (document.asset?.version !== "2.0") throw new Error(`${asset.file} source is not glTF 2.0`);
  if (!Array.isArray(document.buffers) || document.buffers.length !== 1) {
    throw new Error(`${asset.file} must use exactly one source buffer`);
  }
  if (!Array.isArray(document.images) || document.images.length !== 1) {
    throw new Error(`${asset.file} must use exactly one source image`);
  }
  const sourceBufferName = `${asset.sourceBase}.bin`;
  if (document.buffers[0].uri !== sourceBufferName) {
    throw new Error(`${asset.file} unexpected source buffer ${document.buffers[0].uri}`);
  }
  if (document.images[0].uri !== TEXTURE.file) {
    throw new Error(`${asset.file} unexpected source texture ${document.images[0].uri}`);
  }
  if (document.buffers[0].byteLength !== binBytes.length) {
    throw new Error(`${asset.file} source BIN length mismatch`);
  }

  const sourceBin = pad(binBytes);
  const imageOffset = sourceBin.length;
  const embeddedTexture = pad(textureBytes);
  const combined = Buffer.concat([sourceBin, embeddedTexture]);

  document.bufferViews ||= [];
  const imageBufferView = document.bufferViews.push({
    buffer: 0,
    byteOffset: imageOffset,
    byteLength: textureBytes.length,
  }) - 1;
  document.images[0] = {
    ...(document.images[0].name ? { name: document.images[0].name } : {}),
    bufferView: imageBufferView,
    mimeType: "image/png",
  };
  document.buffers[0] = { byteLength: combined.length };
  document.asset.generator = `${document.asset.generator || "glTF"} + MoYoGarden authored building packer`;
  document.asset.extras = {
    ...(document.asset.extras || {}),
    moyoSource: `${UPSTREAM_REPO}@${UPSTREAM_COMMIT}`,
    moyoBuildingType: asset.key,
  };

  const json = pad(Buffer.from(JSON.stringify(document)), 0x20);
  const bin = pad(combined);
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

function validateGlb(bytes, asset) {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF") {
    throw new Error(`${asset.file} is not a GLB file`);
  }
  if (bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${asset.file} has an invalid glTF 2.0 header`);
  }
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.toString("ascii", 16, 20) !== "JSON") throw new Error(`${asset.file} lacks JSON chunk`);
  const document = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).trim());
  if (document.buffers?.[0]?.uri) throw new Error(`${asset.file} retained an external buffer URI`);
  if (document.images?.some((image) => image.uri)) throw new Error(`${asset.file} retained an external image URI`);
  if (!document.images?.[0]?.bufferView && document.images?.[0]?.bufferView !== 0) {
    throw new Error(`${asset.file} texture is not embedded`);
  }
}

await mkdir(OUT, { recursive: true });
const loaded = [];
const failed = [];

let textureResult = null;
if (!SKIP) {
  try {
    textureResult = await fetchPinned(`${SOURCE_ROOT}/${TEXTURE.file}`, TEXTURE.gitBlobSha);
  } catch (error) {
    console.warn("MoYoGarden: KayKit building texture unavailable", error);
  }

  for (const asset of ASSETS) {
    try {
      if (!textureResult) throw new Error("shared KayKit building texture unavailable");
      const [gltf, bin] = await Promise.all([
        fetchPinned(`${SOURCE_ROOT}/${asset.sourceBase}.gltf`, asset.gltfSha),
        fetchPinned(`${SOURCE_ROOT}/${asset.sourceBase}.bin`, asset.binSha),
      ]);
      const output = buildGlb(gltf.bytes, bin.bytes, textureResult.bytes, asset);
      validateGlb(output, asset);
      await writeFile(resolve(OUT, asset.file), output);
      loaded.push({
        key: asset.key,
        file: asset.file,
        sourceBase: asset.sourceBase,
        bytes: output.length,
        gltfSha: asset.gltfSha,
        binSha: asset.binSha,
      });
      console.log(`authored building: ${asset.file} (${output.length} bytes)`);
    } catch (error) {
      failed.push({
        key: asset.key,
        file: asset.file,
        message: error instanceof Error ? error.message : String(error),
      });
      console.warn(`MoYoGarden: optional authored building ${asset.file} unavailable`, error);
    }
  }
}

const notice = [
  "MoYoGarden authored building asset cache",
  `version: ${VERSION}`,
  "",
  "The optional building models in this directory originate from KayKit: Medieval Hexagon Pack (1.0).",
  "License: Creative Commons Zero (CC0).",
  "Created/distributed by Kay Lousberg / KayKit Game Assets.",
  `Pinned source: https://github.com/${UPSTREAM_REPO}/tree/${UPSTREAM_COMMIT}`,
  `Pinned texture: ${TEXTURE.file} | git-blob ${TEXTURE.gitBlobSha}`,
  "",
  ...ASSETS.map((asset) => `${asset.file} | ${asset.original} | CC0 | gltf ${asset.gltfSha} | bin ${asset.binSha}`),
  "",
].join("\n");
await writeFile(resolve(OUT, "NOTICE.txt"), notice);
await writeFile(resolve(OUT, "manifest.json"), JSON.stringify({
  version: VERSION,
  upstreamRepo: UPSTREAM_REPO,
  upstreamCommit: UPSTREAM_COMMIT,
  loaded,
  failed,
}, null, 2));

if (failed.length > 0) {
  console.warn(`MoYoGarden: ${failed.length}/${ASSETS.length} authored buildings unavailable; generated building fallbacks remain enabled`);
  if (REQUIRE) throw new Error("Required authored building assets could not be vendored");
}
