import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const required = [
  "public/index.html",
  "public/app.js",
  "public/detail-upgrade.js",
  "public/pan-invert.js",
  "public/style.css",
];

for (const path of required) {
  const info = await stat(path);
  assert.ok(info.isFile(), `${path} must be a file`);
  assert.ok(info.size > 100, `${path} is unexpectedly small`);
}

const [html, app, detail, pan, packageSource] = await Promise.all([
  readFile("public/index.html", "utf8"),
  readFile("public/app.js", "utf8"),
  readFile("public/detail-upgrade.js", "utf8"),
  readFile("public/pan-invert.js", "utf8"),
  readFile("package.json", "utf8"),
]);
const packageJson = JSON.parse(packageSource);
const browserSource = `${html}\n${app}\n${detail}\n${pan}`;

assert.equal(packageJson.version, "0.3.1");
assert.equal(packageJson.dependencies, undefined, "production recovery build must not download Three.js");
assert.match(packageJson.scripts.build, /verify:web/);
assert.match(packageJson.scripts["verify:web"], /pan-invert\.js/);

assert.match(html, /<canvas id="world"/);
assert.match(html, /MoYoGarden/);
assert.match(html, /\/app\.js\?v=0\.3\.1-safe/);
assert.match(html, /\/detail-upgrade\.js\?v=0\.3\.1-safe/);
assert.match(html, /\/pan-invert\.js\?v=0\.3\.1-safe/);
assert.doesNotMatch(html, /type="importmap"/);
assert.doesNotMatch(html, /type="module"\s+src="\/app\.js"/);
assert.doesNotMatch(html, /PBRモデルを読み込んでいます/);

assert.match(app, /getContext\("webgl2"/);
assert.match(app, /\/api\/stream/);
assert.match(app, /createDemoState/);
assert.match(detail, /detailCylinderGeometry/);
assert.match(detail, /drawDetailedAgent/);
assert.match(detail, /drawDetailedStructure/);
assert.match(pan, /event\.button !== 1/);
assert.match(pan, /const localX = -dx \* amount/);
assert.match(pan, /const localZ = -dy \* amount/);
assert.match(pan, /stopImmediatePropagation/);

assert.doesNotMatch(browserSource, /https?:\/\/(?:unpkg|cdn\.jsdelivr|cdnjs)/i);
console.log("Production recovery 3D client validation passed");
