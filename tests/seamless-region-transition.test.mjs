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
test("soft transition reuses loaded window visuals before background refresh", () => {
  const body = functionBody(appSource, "transitionRegion", "async function loadHighResolutionModels");
  assert.match(body, /\/api\/world\/window\?radius=1&live=1/);
  assert.match(body, /liveNeighborSimulation\?\.syncWindow/);
  assert.match(body, /applyEnvelope/);
  assert.match(body, /buildNeighborPreview\(terrainWindowPayload\)/);
  assert.match(body, /loadTerrainWindow\(true\)/);
  assert.doesNotMatch(body, /clearNeighborPreview\(\)/);
  assert.doesNotMatch(body, /\bconnect\(\)/);

  const liveSync = body.indexOf("liveNeighborSimulation?.syncWindow");
  const promote = body.indexOf("applyEnvelope");
  const terrainReuse = body.indexOf("buildNeighborPreview(terrainWindowPayload)");
  assert.ok(liveSync >= 0 && liveSync < promote, "live neighbors should rebase before center promotion");
  assert.ok(promote >= 0 && promote < terrainReuse, "cached terrain should be recentered after center promotion");
});
