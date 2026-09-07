import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const previewSource = await readFile(
  new URL("../public/client/hex-neighbor-preview.js", import.meta.url),
  "utf8",
);

test("outer terrain ring loads once per center while live neighbors keep ten-second refresh", () => {
  assert.match(appSource, /LIVE_REGION_WINDOW_REFRESH_MS\s*=\s*10_000/);
  assert.match(appSource, /FAR_TERRAIN_RADIUS\s*=\s*2/);
  assert.match(appSource, /NEIGHBOR_TERRAIN_REFRESH_MS\s*=\s*60_000/);
  assert.match(appSource, /\/api\/world\/window\?radius=\$\{FAR_TERRAIN_RADIUS\}&terrain=1/);
  assert.match(appSource, /terrainWindowCenter\s*===\s*app\.region/);
  assert.match(appSource, /refreshNearTerrainFromLive/);
});

test("hex terrain preview topology covers the static radius-two ring", () => {
  assert.match(previewSource, /regionMetaUrl\(requestedCenter,\s*2\)/);
});
