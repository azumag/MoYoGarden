import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

for (const path of [
  "public/index.html",
  "public/app.js",
  "public/detail-upgrade.js",
  "public/style.css",
]) {
  const info = await stat(path);
  assert.ok(info.isFile());
  assert.ok(info.size > 100, `${path} is unexpectedly small`);
}

const html = await readFile("public/index.html", "utf8");
const script = await readFile("public/app.js", "utf8");
const detail = await readFile("public/detail-upgrade.js", "utf8");

assert.match(html, /<canvas id="world"/);
assert.match(html, /MoYoGarden/);
assert.match(html, /src="\/detail-upgrade\.js"/);
assert.match(html, /中ドラッグ/);
assert.match(script, /getContext\("webgl2"/);
assert.match(script, /\/api\/stream/);
assert.match(detail, /drawDetailedAgent/);
assert.match(detail, /drawDetailedStructure/);
assert.match(detail, /event\.button !== 1/);
assert.match(detail, /middlePan/);
assert.doesNotMatch(html, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);
assert.doesNotMatch(script, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);
assert.doesNotMatch(detail, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);

console.log("Detailed 3D static client validation passed");
