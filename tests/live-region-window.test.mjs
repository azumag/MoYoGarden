import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const footprintSource = await readFile(
  new URL("../public/client/hex-footprint-rendering.js", import.meta.url),
  "utf8",
);
const liveRegionSource = await readFile(
  new URL("../public/client/live-region-rendering.js", import.meta.url),
  "utf8",
);

test("browser refreshes a live radius-one simulation window every ten seconds", () => {
  assert.match(appSource, /LIVE_REGION_WINDOW_REFRESH_MS\s*=\s*10_000/);
  assert.match(appSource, /\/api\/world\/window\?radius=1&live=1/);
  assert.match(appSource, /liveNeighborSimulation\?\.syncWindow/);
});

test("neighbor simulation graphics survive center clipping and authored model refreshes", () => {
  assert.match(appSource, /createLiveNeighborSimulation/);
  assert.match(appSource, /liveNeighborSimulation\?\.refreshModelType/);
  assert.match(footprintSource, /live-neighbor-simulation/);
});

test("temporary live-window snapshot gaps keep last-known neighbor objects visible", () => {
  assert.match(liveRegionSource, /const requestedIds = windowRegionIds\(payload, centerRegionId\)/);
  assert.match(liveRegionSource, /if \(requestedIds\.has\(regionId\)\) continue;/);
  assert.doesNotMatch(
    liveRegionSource,
    /new Set\(nextEntries\.map\(\(entry\) => entry\.regionId\)\)/,
  );
});
