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

if (!SKIP) {
  for (const texture of TEXTURES) {
    try {
      const { bytes, url } = await download(texture.sourcePath, 15_000);
      validatePng(bytes, texture);
      await writeFile(resolve(OUT, texture.file), bytes);
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
      await writeFile(resolve(OUT, asset.file), bytes);
      loaded.push({ ...asset, ...metadata, bytes: bytes.length, url });
      console.log(`authored character: ${asset.file} (${bytes.length} bytes, ${metadata.animations} animations)`);
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
