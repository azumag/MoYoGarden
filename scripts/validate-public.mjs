import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
for (const path of ["public/index.html", "public/app.js", "public/style.css"]) {
  const info = await stat(path);
  assert.ok(info.isFile());
  assert.ok(info.size > 100, `${path} is unexpectedly small`);
}
const html = await readFile("public/index.html", "utf8");
const script = await readFile("public/app.js", "utf8");
assert.match(html, /<canvas id="world"/);
assert.match(html, /MoYoGarden/);
assert.match(script, /getContext\("webgl2"/);
assert.match(script, /\/api\/stream/);
assert.doesNotMatch(html, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);
assert.doesNotMatch(script, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);
console.log("3D static client validation passed");
