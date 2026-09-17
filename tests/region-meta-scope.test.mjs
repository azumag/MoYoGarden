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

test("neighbor preview bounds stale or hung topology metadata reads", () => {
  assert.match(previewSource, /TOPOLOGY_REQUEST_TIMEOUT_MS\s*=\s*8_000/);
  assert.match(previewSource, /signal:\s*abortController\.signal/);
  assert.match(previewSource, /requestTimedOut\s*=\s*true/);
  assert.match(previewSource, /abortController\.abort\(\)/);
  assert.match(previewSource, /error\?\.name === "AbortError" && !requestTimedOut/);
  assert.match(previewSource, /noteTopologyRetryFailure\(requestedCenter\)/);
  assert.match(previewSource, /clearTimeout\(timeout\)/);
});

test("seamless navigation backs off failed region metadata retries", () => {
  assert.match(navigationSource, /REGION_LAYOUT_RETRY_MIN_MS\s*=\s*1_000/);
  assert.match(navigationSource, /REGION_LAYOUT_RETRY_MAX_MS\s*=\s*15_000/);
  assert.match(navigationSource, /if \(!canRequestRegionLayout\(centerRegionId\)\) return/);
  assert.match(navigationSource, /regionLayoutRetryFailures \+= 1/);
  assert.match(navigationSource, /Math\.min\(regionLayoutRetryFailures - 1, 4\)/);
  assert.match(navigationSource, /noteRegionLayoutFailure\(requestedCenter\)/);
  assert.match(navigationSource, /resetRegionLayoutRetry\(requestedCenter\)/);
  assert.match(navigationSource, /Array\.isArray\(next\) && next\.length > 0/);
});

test("seamless navigation bounds stalled passive region prewarms", () => {
  assert.match(navigationSource, /PREFETCH_TIMEOUT_MS\s*=\s*8_000/);
  assert.match(navigationSource, /setTimeout\(\(\) => controller\.abort\(\), PREFETCH_TIMEOUT_MS\)/);
  assert.match(
    navigationSource,
    /\.\.\.regionWarmSnapshotRequestInit\(\),\s*signal:\s*controller\.signal/s,
  );
  assert.match(navigationSource, /regionWarmAt\.delete\(regionId\)/);
  assert.match(navigationSource, /clearTimeout\(timeout\)/);
  assert.match(navigationSource, /regionWarmRequests\.delete\(regionId\)/);
});

test("seamless navigation bounds sparse-world prewarm cooldown memory", () => {
  assert.match(navigationSource, /PREFETCH_COOLDOWN_CACHE_LIMIT\s*=\s*128/);
  assert.match(navigationSource, /now - warmedAt >= PREFETCH_REFRESH_MS/);
  assert.match(navigationSource, /regionWarmAt\.size > PREFETCH_COOLDOWN_CACHE_LIMIT/);
  assert.match(navigationSource, /regionWarmAt\.keys\(\)\.next\(\)\.value/);
  assert.match(navigationSource, /pruneRegionWarmCooldowns\(now\)/);
  assert.match(navigationSource, /rememberRegionWarm\(regionId\)/);
});
