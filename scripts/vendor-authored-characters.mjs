import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "public/assets/authored/kaykit-adventurers");
const UPSTREAM_REPO = "KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0";
const UPSTREAM_COMMIT = "672074b73ba276876a19e8816ecdc5241817ab47";
const VERSION = "0.3.11";
const REQUIRE = process.env.MOYO_REQUIRE_AUTHORED_CHARACTERS === "1";
const SKIP = process.env.MOYO_SKIP_AUTHORED_CHARACTERS === "1";

const ASSETS = Object.freeze([
  {
    key: "authored:agent-worker",
    file: "worker.glb",
    sourcePath: "addons/kaykit_character_pack_adventures/Characters/gltf/Barbarian.glb",
    gitBlobSha: "66d312ab6dc02b35fb648e7585bfdddb4e02eeef",
    original: "Barbarian.glb",
  },
  {
    key: "authored:agent-roamer",
    file: "roamer.glb",
    sourcePath: "addons/kaykit_character_pack_adventures/Characters/gltf/Rogue_Hooded.glb",
    gitBlobSha: "5d2b1403240d5f9ffff12e02c007572038eca2a8",
    original: "Rogue_Hooded.glb",
  },
]);

const TEXTURES = Object.freeze([
  {
    file: "barbarian_texture.png",
    sourcePath: "addons/kaykit_character_pack_adventures/Characters/gltf/barbarian_texture.png",
    gitBlobSha: "29d2db09000ac28e626cf24c3d5ff48f7c324351",
  },
  {
    file: "rogue_texture.png",
    sourcePath: "addons/kaykit_character_pack_adventures/Characters/gltf/rogue_texture.png",
    gitBlobSha: "542954baba7281f028f93306943fc780b1ebcf55",
  },
]);

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function parseGlbDocument(bytes, asset) {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF") {
    throw new Error(`${asset.file} is not a GLB file`);
  }
  if (bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${asset.file} has an invalid glTF 2.0 header`);
  }
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.toString("ascii", 16, 20) !== "JSON") {
    throw new Error(`${asset.file} has no GLB JSON chunk`);
  }
  return JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).trim());
}

function glbBinChunk(bytes, asset) {
  const jsonLength = bytes.readUInt32LE(12);
  let offset = 20 + jsonLength;
  while (offset + 8 <= bytes.length) {
    const chunkLength = bytes.readUInt32LE(offset);
    const chunkType = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (dataEnd > bytes.length) throw new Error(`${asset.file} has a truncated GLB chunk`);
    if (chunkType === 0x004e4942) return Buffer.from(bytes.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }
  throw new Error(`${asset.file} has no GLB BIN chunk`);
}

function padBuffer(bytes, fill = 0) {
  const padding = (4 - (bytes.length % 4)) % 4;
  return padding === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(padding, fill)]);
}

function encodeGlb(document, binBytes) {
  const json = padBuffer(Buffer.from(JSON.stringify(document), "utf8"), 0x20);
  const bin = padBuffer(binBytes, 0);
  const totalLength = 12 + 8 + json.length + 8 + bin.length;
  const output = Buffer.allocUnsafe(totalLength);
  output.write("glTF", 0, 4, "ascii");
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  const binHeader = 20 + json.length;
  output.writeUInt32LE(bin.length, binHeader);
  output.writeUInt32LE(0x004e4942, binHeader + 4);
  bin.copy(output, binHeader + 8);
  return output;
}

function imageFileName(uri) {
  const clean = uri.split(/[?#]/, 1)[0];
  const parts = clean.split(/[\\/]/);
  try {
    return decodeURIComponent(parts.at(-1) || "");
  } catch {
    return parts.at(-1) || "";
  }
}

function embedExternalImages(bytes, asset, texturesByFile) {
  const document = parseGlbDocument(bytes, asset);
  const externalImages = (document.images || [])
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => typeof image.uri === "string" && !image.uri.startsWith("data:"));
  if (externalImages.length === 0) return { bytes, embeddedImages: [] };

  if (!Array.isArray(document.buffers) || document.buffers.length === 0 || typeof document.buffers[0].uri === "string") {
    throw new Error(`${asset.file} cannot embed images without an internal GLB buffer`);
  }
  if (!Array.isArray(document.bufferViews)) document.bufferViews = [];

  let bin = glbBinChunk(bytes, asset);
  const embeddedImages = [];
  for (const { image, index } of externalImages) {
    bin = padBuffer(bin, 0);
    const file = imageFileName(image.uri);
    const textureBytes = texturesByFile.get(file);
    if (!textureBytes) {
      throw new Error(`${asset.file} external image ${image.uri} is unavailable for embedding`);
    }
    const byteOffset = bin.length;
    const bufferView = document.bufferViews.length;
    document.bufferViews.push({ buffer: 0, byteOffset, byteLength: textureBytes.length });
    bin = Buffer.concat([bin, textureBytes]);
    delete image.uri;
    image.bufferView = bufferView;
    image.mimeType = "image/png";
    embeddedImages.push({ index, file, bytes: textureBytes.length });
  }

  document.buffers[0].byteLength = bin.length;
  return { bytes: encodeGlb(document, bin), embeddedImages };
}

function validatePackedCharacterGlb(bytes, asset) {
  const document = parseGlbDocument(bytes, asset);
  const bin = glbBinChunk(bytes, asset);
  const bufferLength = document.buffers?.[0]?.byteLength;
  if (!Number.isInteger(bufferLength) || bufferLength > bin.length) {
    throw new Error(`${asset.file} packed buffer length is invalid`);
  }
  for (const image of document.images || []) {
    if (typeof image.uri === "string" && !image.uri.startsWith("data:")) {
      throw new Error(`${asset.file} still references external image ${image.uri}`);
    }
    if (!Number.isInteger(image.bufferView)) continue;
    const view = document.bufferViews?.[image.bufferView];
    if (!view || view.buffer !== 0 || !Number.isInteger(view.byteLength)) {
      throw new Error(`${asset.file} has an invalid embedded image bufferView`);
    }
    const start = view.byteOffset || 0;
    if (start < 0 || start + view.byteLength > bufferLength) {
      throw new Error(`${asset.file} embedded image exceeds its GLB buffer`);
    }
  }
}

function validateCharacterGlb(bytes, asset) {
  const actualSha = gitBlobSha(bytes);
  if (actualSha !== asset.gitBlobSha) {
    throw new Error(`${asset.file} blob SHA mismatch: ${actualSha}`);
  }
  const document = parseGlbDocument(bytes, asset);
  if (!Array.isArray(document.skins) || document.skins.length === 0) {
    throw new Error(`${asset.file} has no skin`);
  }
  if (!Array.isArray(document.animations) || document.animations.length === 0) {
    throw new Error(`${asset.file} has no animations`);
  }
  return {
    animations: document.animations.length,
    skins: document.skins.length,
    externalImages: (document.images || []).filter((image) => typeof image.uri === "string").map((image) => image.uri),
  };
}

function validatePng(bytes, texture) {
  if (gitBlobSha(bytes) !== texture.gitBlobSha) {
    throw new Error(`${texture.file} blob SHA mismatch`);
  }
  const signature = bytes.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") throw new Error(`${texture.file} is not PNG`);
}

async function download(path, timeoutMs = 25_000) {
  const url = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_COMMIT}/${path}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "MoYoGarden-build" },
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), url };
}

await mkdir(OUT, { recursive: true });
const loaded = [];
const failed = [];
const loadedTextures = [];
const textureBytesByFile = new Map();

if (!SKIP) {
  for (const texture of TEXTURES) {
    try {
      const { bytes, url } = await download(texture.sourcePath, 15_000);
      validatePng(bytes, texture);
      await writeFile(resolve(OUT, texture.file), bytes);
      textureBytesByFile.set(texture.file, bytes);
      loadedTextures.push({ ...texture, bytes: bytes.length, url });
      console.log(`authored character texture: ${texture.file} (${bytes.length} bytes)`);
    } catch (error) {
      failed.push({ key: `texture:${texture.file}`, file: texture.file, message: error instanceof Error ? error.message : String(error) });
      console.warn(`MoYoGarden: optional authored character texture ${texture.file} unavailable`, error);
    }
  }

  for (const asset of ASSETS) {
    try {
      const { bytes, url } = await download(asset.sourcePath);
      const metadata = validateCharacterGlb(bytes, asset);
      const packed = embedExternalImages(bytes, asset, textureBytesByFile);
      if (packed.embeddedImages.length !== metadata.externalImages.length) {
        throw new Error(`${asset.file} did not embed every external image`);
      }
      validatePackedCharacterGlb(packed.bytes, asset);
      await writeFile(resolve(OUT, asset.file), packed.bytes);
      loaded.push({
        ...asset,
        ...metadata,
        bytes: packed.bytes.length,
        sourceBytes: bytes.length,
        embeddedImages: packed.embeddedImages,
        url,
      });
      console.log(`authored character: ${asset.file} (${packed.bytes.length} bytes, ${metadata.animations} animations, ${packed.embeddedImages.length} embedded images)`);
    } catch (error) {
      failed.push({ key: asset.key, file: asset.file, message: error instanceof Error ? error.message : String(error) });
      console.warn(`MoYoGarden: optional authored character ${asset.file} unavailable`, error);
    }
  }
}

const notice = [
  "MoYoGarden authored character cache",
  `version: ${VERSION}`,
  "",
  "The optional character models in this directory originate from KayKit: Character Pack - Adventurers.",
  "License: Creative Commons Zero (CC0) 1.0 Universal; attribution is not required.",
  "Creator: Kay Lousberg / KayKit Game Assets.",
  `Pinned source: https://github.com/${UPSTREAM_REPO}/tree/${UPSTREAM_COMMIT}`,
  "",
  ...ASSETS.map((asset) => `${asset.file} | ${asset.original} | CC0 | git-blob ${asset.gitBlobSha}`),
  ...TEXTURES.map((asset) => `${asset.file} | CC0 | git-blob ${asset.gitBlobSha}`),
  "",
].join("\n");

await writeFile(resolve(OUT, "NOTICE.txt"), notice);
await writeFile(resolve(OUT, "manifest.json"), JSON.stringify({
  version: VERSION,
  upstreamRepo: UPSTREAM_REPO,
  upstreamCommit: UPSTREAM_COMMIT,
  loaded,
  loadedTextures,
  failed,
}, null, 2));

const missingModels = ASSETS.filter((asset) => !loaded.some((entry) => entry.key === asset.key));
if (missingModels.length > 0) {
  console.warn(`MoYoGarden: ${missingModels.length}/${ASSETS.length} authored character models unavailable; generated settlers remain enabled`);
  if (REQUIRE) throw new Error("Required authored character assets could not be vendored");
}
