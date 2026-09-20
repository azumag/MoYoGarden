import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const seamlessSource = await readFile(
  new URL("../public/client/seamless-navigation.js", import.meta.url),
  "utf8",
);

function functionBody(source, name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`\n${nextName}`, start);
  assert.ok(start >= 0, `missing ${name}`);
  assert.ok(end > start, `missing end marker for ${name}`);
  return source.slice(start, end);
}

test("automatic region crossing requests a soft transition instead of clicking reconnect", () => {
  assert.match(seamlessSource, /moyo:region-transition/);
  assert.doesNotMatch(seamlessSource, /reconnect\.click\(\)/);
  assert.match(appSource, /addEventListener\("moyo:region-transition"/);
});

test("soft transition keeps the loaded world visible while target state is prepared", () => {
  const body = functionBody(appSource, "transitionRegion", "async function loadHighResolutionModels");
  assert.match(body, /\/api\/world\/window\?radius=1&live=1/);
  assert.match(body, /liveNeighborSimulation\?\.syncWindow/);
  assert.match(body, /applyEnvelope/);
  assert.doesNotMatch(body, /clearNeighborPreview\(\)/);
  assert.doesNotMatch(body, /\bconnect\(\)/);

  const liveSync = body.indexOf("liveNeighborSimulation?.syncWindow");
  const promote = body.indexOf("applyEnvelope");
  assert.ok(liveSync >= 0 && liveSync < promote, "live neighbors should rebase before center promotion");
});

test("soft transition requires the live center but treats health and far terrain as best-effort", () => {
  const body = functionBody(appSource, "transitionRegion", "async function loadHighResolutionModels");
  assert.match(body, /requestJson\("\/api\/world\/window\?radius=1&live=1", \{\}, 10_000\)/);
  assert.match(body, /requestOptionalJson\("\/api\/health"\)/);
  assert.match(
    body,
    /requestOptionalJson\(`\/api\/world\/window\?radius=\$\{FAR_TERRAIN_RADIUS\}&terrain=1`, \{\}, 12_000\)/,
  );
  assert.match(body, /terrainPayload \?\? windowPayload/);
  assert.match(body, /if \(!terrainPayload\) void loadTerrainWindow\(true\);/);
  assert.match(body, /buildNeighborPreview\(terrainWindowPayload\)/);

  const liveWindow = body.indexOf("requestJson(\"/api/world/window?radius=1&live=1\"");
  const promote = body.indexOf("applyEnvelope");
  assert.ok(liveWindow >= 0 && liveWindow < promote, "live center remains the transition authority");
});

test("snapshot startup keeps the world when health is temporarily unavailable", () => {
  assert.match(appSource, /async function requestOptionalJson/);
  const body = functionBody(appSource, "loadSnapshot", "function startPolling");
  assert.match(body, /requestJson\("\/api\/world\/snapshot"\)/);
  assert.match(body, /requestOptionalJson\("\/api\/health"\)/);
  assert.match(body, /health\?\.paused/);
  assert.match(body, /health\?\.tickMs/);
});

test("same-region re-entry ignores stale terrain and transition responses", () => {
  assert.match(appSource, /let terrainWindowRequestVersion = 0;/);
  assert.match(appSource, /let liveRegionWindowRequestVersion = 0;/);
  assert.match(appSource, /let regionTransitionVersion = 0;/);

  const terrainBody = functionBody(appSource, "loadTerrainWindow", "function refreshNearTerrainFromLive");
  assert.match(terrainBody, /const requestVersion = \+\+terrainWindowRequestVersion;/);
  assert.match(
    terrainBody,
    /requestVersion !== terrainWindowRequestVersion \|\| requestedRegion !== app\.region/,
  );

  const liveWindowBody = functionBody(appSource, "loadRegionWindow", "function startRegionWindowRefresh");
  assert.match(liveWindowBody, /const requestVersion = \+\+liveRegionWindowRequestVersion;/);
  assert.match(
    liveWindowBody,
    /requestVersion !== liveRegionWindowRequestVersion \|\| requestedRegion !== app\.region/,
  );

  const connectBody = functionBody(appSource, "connect", "async function transitionRegion");
  assert.match(connectBody, /regionTransitionVersion \+= 1;/);
  assert.match(connectBody, /terrainWindowRequestVersion \+= 1;/);
  assert.match(connectBody, /liveRegionWindowRequestVersion \+= 1;/);

  const transitionBody = functionBody(appSource, "transitionRegion", "async function loadHighResolutionModels");
  assert.match(transitionBody, /const transitionVersion = \+\+regionTransitionVersion;/);
  assert.match(transitionBody, /terrainWindowRequestVersion \+= 1;/);
  assert.match(transitionBody, /liveRegionWindowRequestVersion \+= 1;/);
  const staleGuards = transitionBody.match(
    /transitionVersion !== regionTransitionVersion \|\| app\.region !== targetRegion/g,
  ) || [];
  assert.equal(staleGuards.length, 2, "success and failure paths must both reject stale transitions");
});
