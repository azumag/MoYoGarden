import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, boot] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/boot.js", import.meta.url), "utf8"),
]);

test("bootstrap loader refreshes once and runtime modules follow deployed commit", () => {
  assert.match(html, /boot\.js\?v=0\.3\.11&loader=commit-aware-1/);
  assert.match(boot, /resolveAssetVersion/);
  assert.match(boot, /new URL\("\/api\/meta", location\.origin\)/);
  assert.match(boot, /cache:\s*"no-store"/);
  assert.match(boot, /payload\?\.build\?\.commit/);
  assert.match(boot, /\^\[0-9a-f\]\{7,64\}\$/i);
  assert.match(boot, /VERSION = await resolveAssetVersion\(\)/);
  assert.match(boot, /\/app\.js\?v=\$\{VERSION\}/);

  const resolve = boot.indexOf("VERSION = await resolveAssetVersion()");
  const preload = boot.indexOf("preloadRuntime();", resolve);
  const app = boot.indexOf("moduleScript.src = `/app.js?v=${VERSION}`", resolve);
  assert.ok(resolve >= 0);
  assert.ok(preload > resolve, "runtime preloads must wait for deployed commit lookup");
  assert.ok(app > preload, "app module must use the same resolved commit cache key");
});

test("commit lookup fails soft to the packaged release key", () => {
  assert.match(boot, /let VERSION = "0\.3\.11"/);
  assert.match(boot, /ASSET_VERSION_TIMEOUT_MS\s*=\s*1_500/);
  assert.match(boot, /return VERSION/);
  assert.match(boot, /AbortController/);
});
