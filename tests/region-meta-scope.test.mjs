import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const navigationSource = await readFile(new URL("../public/client/seamless-navigation.js", import.meta.url), "utf8");
const previewSource = await readFile(new URL("../public/client/hex-neighbor-preview.js", import.meta.url), "utf8");

test("browser topology consumers scope metadata to their loaded hex windows", () => {
  assert.match(appSource, /regionMetaUrl\(app\.region/);
  assert.match(navigationSource, /regionMetaUrl\((?:requestedCenter|centerRegionId), 1\)/);
  assert.match(previewSource, /regionMetaUrl\((?:requestedCenter|centerRegionId), 2\)/);
  assert.doesNotMatch(navigationSource, /fetch\(["'`]\/api\/meta["'`]/);
  assert.doesNotMatch(previewSource, /fetch\(["'`]\/api\/meta["'`]/);
});

test("seamless navigation bounds stale or hung region metadata reads", () => {
  assert.match(navigationSource, /REGION_LAYOUT_TIMEOUT_MS\s*=\s*8_000/);
  assert.match(navigationSource, /regionLayoutRequestController\?\.abort\(\)/);
  assert.match(navigationSource, /signal:\s*controller\.signal/);
  assert.match(navigationSource, /setTimeout\(\(\) => controller\.abort\(\), REGION_LAYOUT_TIMEOUT_MS\)/);
  assert.match(navigationSource, /regionLayoutRequestController === controller/);
  assert.match(navigationSource, /error\?\.name !== "AbortError"/);
});
