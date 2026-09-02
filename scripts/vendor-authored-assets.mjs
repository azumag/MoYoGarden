import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "public/assets/authored/kenney");
const UPSTREAM_REPO = "syuhei176/ai-game-assets";
const UPSTREAM_COMMIT = "ebfd758dea8db5793c765cc72564efadb36a4ed0";
const VERSION = "0.3.7";
const REQUIRE = process.env.MOYO_REQUIRE_AUTHORED_ASSETS === "1";
const SKIP = process.env.MOYO_SKIP_AUTHORED_ASSETS === "1";

const ASSETS = Object.freeze([
  {
    key: "authored:tree-oak",
    file: "tree_oak.glb",
    sourcePath: "models/environment/tree_oak.glb",
    gitBlobSha: "b136723ada4b5574b71f727120ab21fa579bf2fb",
    original: "Kenney Nature Kit",
  },
  {
    key: "authored:tree-pine",
    file: "tree_pine.glb",
    sourcePath: "models/environment/tree_pine.glb",
    gitBlobSha: "f1217a9ee5b1d8f2027d39fe6bd151d20be5ab84",
    original: "Kenney Nature Kit",
  },
  {
    key: "authored:rock-large",
    file: "rock_large.glb",
    sourcePath: "models/environment/rock_large.glb",
    gitBlobSha: "40e1365a43b706bd78c2658b48b189c9a35f8923",
    original: "Kenney Nature Kit",
  },
  {
    key: "authored:rock-medium",
    file: "rock_medium.glb",
    sourcePath: "models/environment/rock_medium.glb",
    gitBlobSha: "31d1fb480f2bd18b47e7d6b8e2308d4b7301da4a",
    original: "Kenney Nature Kit",
  },
  {
    key: "authored:rock-small",
    file: "rock_small.glb",
    sourcePath: "models/environment/rock_small.glb",
    gitBlobSha: "b23471253cfafcca5916ffddb79853eca7433195",
    original: "Kenney Nature Kit",
  },
]);

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function validateGlb(bytes, asset) {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF") {
    throw new Error(`${asset.file} is not a GLB file`);
  }
  if (bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${asset.file} has an invalid glTF 2.0 header`);
  }
  const actualSha = gitBlobSha(bytes);
  if (actualSha !== asset.gitBlobSha) {
    throw new Error(`${asset.file} blob SHA mismatch: ${actualSha}`);
  }
}

async function downloadAsset(asset) {
  const url = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_COMMIT}/${asset.sourcePath}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "MoYoGarden-build" },
  });
  if (!response.ok) throw new Error(`${asset.file} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  validateGlb(bytes, asset);
  await writeFile(resolve(OUT, asset.file), bytes);
  return { ...asset, bytes: bytes.length, url };
}

await mkdir(OUT, { recursive: true });
const loaded = [];
const failed = [];

if (!SKIP) {
  for (const asset of ASSETS) {
    try {
      const result = await downloadAsset(asset);
      loaded.push(result);
      console.log(`authored asset: ${asset.file} (${result.bytes} bytes)`);
    } catch (error) {
      failed.push({ key: asset.key, file: asset.file, message: error instanceof Error ? error.message : String(error) });
      console.warn(`MoYoGarden: optional authored asset ${asset.file} unavailable`, error);
    }
  }
}

const notice = [
  "MoYoGarden authored asset cache",
  `version: ${VERSION}`,
  "",
  "The optional nature models in this directory originate from Kenney Nature Kit.",
  "Kenney Nature Kit is licensed Creative Commons CC0 1.0 (public domain).",
  "Official source: https://kenney.nl/assets/nature-kit",
  `Pinned mirror: https://github.com/${UPSTREAM_REPO}/tree/${UPSTREAM_COMMIT}`,
  "",
  ...ASSETS.map((asset) => `${asset.file} | ${asset.original} | CC0 | git-blob ${asset.gitBlobSha}`),
  "",
].join("\n");
await writeFile(resolve(OUT, "NOTICE.txt"), notice);
await writeFile(resolve(OUT, "manifest.json"), JSON.stringify({ version: VERSION, loaded, failed }, null, 2));

if (failed.length > 0) {
  console.warn(`MoYoGarden: ${failed.length}/${ASSETS.length} authored assets unavailable; procedural fallbacks remain enabled`);
  if (REQUIRE) throw new Error("Required authored assets could not be vendored");
}
