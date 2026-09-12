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

test("authored BOT models load immediately after core fallback models", () => {
  const coreFallbacks = ["settler", "buildings", "tree", "rock"].map(manifestIndex);
  const worker = manifestIndex("authored:agent-worker");
  const roamer = manifestIndex("authored:agent-roamer");
  const firstOptionalEnvironmentModel = manifestIndex("authored:building-camp");

  for (const index of [...coreFallbacks, worker, roamer, firstOptionalEnvironmentModel]) {
    assert.notEqual(index, -1);
  }

  assert.ok(Math.max(...coreFallbacks) < worker, "procedural/core fallbacks must stay first");
  assert.ok(worker < roamer, "worker and roamer should keep a deterministic load order");
  assert.ok(roamer < firstOptionalEnvironmentModel, "visible BOT overrides should not wait behind authored buildings");
});
