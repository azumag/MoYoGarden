import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const modelLibrarySource = await readFile(
  new URL("../public/client/model-library.js", import.meta.url),
  "utf8",
);

function manifestIndex(key) {
  return modelLibrarySource.indexOf(`["${key}"`);
}

test("authored BOT models upgrade before static core GLBs", () => {
  const settler = manifestIndex("settler");
  const worker = manifestIndex("authored:agent-worker");
  const roamer = manifestIndex("authored:agent-roamer");
  const staticFallbacks = ["buildings", "tree", "rock"].map(manifestIndex);
  const firstOptionalEnvironmentModel = manifestIndex("authored:building-camp");

  for (const index of [settler, worker, roamer, ...staticFallbacks, firstOptionalEnvironmentModel]) {
    assert.notEqual(index, -1);
  }

  assert.ok(settler < worker, "settler fallback should be available before authored BOT upgrades");
  assert.ok(worker < roamer, "worker and roamer should keep a deterministic load order");
  assert.ok(
    roamer < Math.min(...staticFallbacks),
    "moving BOT overrides should not wait behind static building/tree/rock GLBs",
  );
  assert.ok(
    Math.max(...staticFallbacks) < firstOptionalEnvironmentModel,
    "core static GLBs should still precede optional authored environment assets",
  );
});

test("authored BOT skeleton cloning preloads in parallel with the GLB fetch", () => {
  const prefetch = modelLibrarySource.indexOf("const skeletonClonePromise = isAuthoredAgentKey(key)");
  const load = modelLibrarySource.indexOf("const gltf = await loadWithTimeout", prefetch);
  const join = modelLibrarySource.indexOf("if (skeletonClonePromise) await skeletonClonePromise", load);

  assert.notEqual(prefetch, -1);
  assert.notEqual(load, -1);
  assert.notEqual(join, -1);
  assert.ok(prefetch < load, "SkeletonUtils import should begin before the character fetch/parse finishes");
  assert.ok(load < join, "the preload should only be awaited when the character template is ready to publish");
});
