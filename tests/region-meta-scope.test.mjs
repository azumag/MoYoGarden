import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const navigationSource = await readFile(new URL("../public/client/seamless-navigation.js", import.meta.url), "utf8");
const previewSource = await readFile(new URL("../public/client/hex-neighbor-preview.js", import.meta.url), "utf8");

test("browser topology consumers request metadata for the current radius-one hex window", () => {
  assert.match(appSource, /regionMetaUrl\(app\.region/);
  assert.match(navigationSource, /regionMetaUrl\((?:requestedCenter|centerRegionId), 1\)/);
  assert.match(previewSource, /regionMetaUrl\((?:requestedCenter|centerRegionId), 1\)/);
  assert.doesNotMatch(navigationSource, /fetch\(["'`]\/api\/meta["'`]/);
  assert.doesNotMatch(previewSource, /fetch\(["'`]\/api\/meta["'`]/);
});
