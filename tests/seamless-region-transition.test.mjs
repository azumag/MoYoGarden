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

test("soft transition waits for target terrain instead of rebuilding old-center staging data", () => {
  const body = functionBody(appSource, "transitionRegion", "async function loadHighResolutionModels");
  assert.doesNotMatch(body, /cachedTerrainWindow/);
  assert.match(body, /radius=\$\{FAR_TERRAIN_RADIUS\}&terrain=1/);
  assert.match(body, /buildNeighborPreview\(terrainWindowPayload\)/);
  assert.doesNotMatch(body, /loadTerrainWindow\(true\)/);

  const fetchTerrain = body.indexOf("terrain=1");
  const promote = body.indexOf("applyEnvelope");
  const rebuild = body.indexOf("buildNeighborPreview(terrainWindowPayload)");
  assert.ok(fetchTerrain >= 0 && fetchTerrain < promote, "target terrain must be ready before promotion");
  assert.ok(promote >= 0 && promote < rebuild, "new center must be active before target terrain is rebuilt");
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
