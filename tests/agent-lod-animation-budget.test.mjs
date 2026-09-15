import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../public/client/agents.js", import.meta.url), "utf8");

test("procedural agent animation only traverses the currently visible LOD model", () => {
  assert.match(source, /const visibleProceduralModels = \[entry\.high, entry\.medium\]\.filter/);
  assert.match(source, /model\?\.visible && !model\.userData\?\.moyoAuthoredAgent/);
  assert.match(source, /for \(const model of visibleProceduralModels\)/);
  assert.doesNotMatch(source, /for \(const model of \[entry\.high, entry\.medium\]\)/);
});

test("hidden selection rings do not receive per-frame rotation writes", () => {
  assert.match(source, /if \(entry\.ring\.visible\) entry\.ring\.rotation\.z = time \* 0\.0012/);
});
