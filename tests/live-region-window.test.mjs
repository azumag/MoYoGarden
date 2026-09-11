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

test("neighbor BOTs use a readable low-cost head-and-stick glyph", () => {
  assert.match(liveRegionSource, /function createNeighborAgentGlyph\(proxy, agent, faction\)/);
  assert.match(liveRegionSource, /new THREE\.CylinderGeometry\(0\.085, 0\.1, 0\.82, 6\)/);
  assert.match(liveRegionSource, /new THREE\.SphereGeometry\(0\.22, 8, 6\)/);
  assert.match(liveRegionSource, /proxy\.createAgent = \(agent, faction\) => createNeighborAgentGlyph\(proxy, agent, faction\)/);
  assert.match(liveRegionSource, /contactShadow: null/);
});

test("temporary live-window snapshot gaps keep last-known neighbor objects visible", () => {
  assert.match(liveRegionSource, /const requestedIds = windowRegionIds\(payload, centerRegionId\)/);
  assert.match(liveRegionSource, /if \(requestedIds\.has\(regionId\)\) \{/);
  assert.doesNotMatch(
    liveRegionSource,
    /new Set\(nextEntries\.map\(\(entry\) => entry\.regionId\)\)/,
  );
});

test("retained partial neighbors rebase from placement metadata even without a fresh state", () => {
  assert.match(liveRegionSource, /const placements = windowPlacements\(payload, centerRegionId\)/);
  assert.match(
    liveRegionSource,
    /const placement = placements\.get\(regionId\);[\s\S]*entry\.group\.position\.set\(placement\.offsetX, 0, placement\.offsetZ\);/,
  );
  const placementUpdate = liveRegionSource.indexOf("const placement = placements.get(regionId)");
  const healthyStateLoop = liveRegionSource.indexOf("for (const next of nextEntries)");
  assert.ok(placementUpdate >= 0 && placementUpdate < healthyStateLoop);
});

test("out-of-order live windows cannot roll neighbor simulation graphics backward", () => {
  assert.match(liveRegionSource, /function isStaleSnapshot\(proxy, state\)/);
  assert.match(liveRegionSource, /incomingTick < currentTick/);
  assert.match(
    liveRegionSource,
    /else if \(!isStaleSnapshot\(entry\.proxy, next\.state\)\) \{[\s\S]*syncProxy\(entry\.proxy, next\.state, tickMs\);/,
  );
  const staleGuard = liveRegionSource.indexOf("else if (!isStaleSnapshot(entry.proxy, next.state))");
  const placementUpdate = liveRegionSource.indexOf("entry.group.position.set(next.offsetX, 0, next.offsetZ)", staleGuard);
  assert.ok(staleGuard >= 0 && placementUpdate > staleGuard);
});
