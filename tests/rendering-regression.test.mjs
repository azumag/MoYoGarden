import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const modelLibrarySource = await readFile(new URL("../public/client/model-library.js", import.meta.url), "utf8");
const skyFixSource = await readFile(new URL("../public/client/sky-fix.js", import.meta.url), "utf8");
const bootSource = await readFile(new URL("../public/boot.js", import.meta.url), "utf8");
const packageSource = await readFile(new URL("../package.json", import.meta.url), "utf8");
const decayDressingSource = await readFile(
  new URL("../public/client/decay-dressing.js", import.meta.url),
  "utf8",
).catch(() => "");
const quaterniusVendorSource = await readFile(
  new URL("../scripts/vendor-quaternius-decay.mjs", import.meta.url),
  "utf8",
).catch(() => "");

test("authored models keep a useful loading window instead of a 2.5 second cap", () => {
  assert.doesNotMatch(modelLibrarySource, /Math\.min\(timeoutMs,\s*2_500\)/);
  assert.match(modelLibrarySource, /Math\.max\(timeoutMs,\s*12_000\)/);
});

test("visual patch applies the darker decayed world grade", () => {
  assert.match(skyFixSource, /toneMappingExposure\s*=\s*0\.78/);
  assert.match(skyFixSource, /hemi\.intensity\s*=\s*1\.08/);
  assert.match(skyFixSource, /sun\.intensity\s*=\s*2\.05/);
  assert.match(skyFixSource, /moyoDecayStyled/);
  assert.match(skyFixSource, /offsetHSL\(0,\s*-0\.18,\s*-0\.08\)/);
});

test("deferred IBL initialization cannot restore the brighter environment intensity", () => {
  assert.match(
    skyFixSource,
    /}\n\n\s*view\.scene\.environmentIntensity\s*=\s*0\.42;\n\n\s*const now = performance\.now\(\)/,
  );
});

test("terrain adds instanced deadwood, rubble, and mud dressing", () => {
  assert.match(decayDressingSource, /MoyoDecayDressing/);
  assert.match(decayDressingSource, /MoyoDecayDeadwood/);
  assert.match(decayDressingSource, /MoyoDecayRubble/);
  assert.match(decayDressingSource, /MoyoDecayMudPatch/);
  assert.match(decayDressingSource, /InstancedMesh/);
});

test("decay dressing respects the active hex region footprint", () => {
  assert.match(decayDressingSource, /isHexGridCell/);
  assert.match(decayDressingSource, /isHexGridCell\(tile,\s*state\.width,\s*state\.height\)/);
});

test("buildings receive deterministic broken and rusted decay details", () => {
  assert.match(decayDressingSource, /MoyoDecayArchitecture/);
  assert.match(decayDressingSource, /MoyoBrokenPlank/);
  assert.match(decayDressingSource, /MoyoRustPatch/);
  assert.match(decayDressingSource, /hash2\(structure\.position\.x/);
});

test("boot loads decay dressing after hex terrain patches", () => {
  assert.match(bootSource, /decay-dressing\.js/);
  assert.match(bootSource, /decay dressing failed/);
  assert.ok(bootSource.lastIndexOf("hex-terrain-stitching.js") < bootSource.lastIndexOf("decay-dressing.js"));
});

test("Quaternius decay vendor is pinned and strips heavyweight texture dependencies", () => {
  assert.match(quaterniusVendorSource, /db3df04d1e4714298a09510b26fb6de6645138a2/);
  assert.match(quaterniusVendorSource, /Prop_Brick1\.gltf/);
  assert.match(quaterniusVendorSource, /Prop_Support\.gltf/);
  assert.match(quaterniusVendorSource, /Prop_WoodenFence_Single\.gltf/);
  assert.match(quaterniusVendorSource, /delete document\.images/);
  assert.match(quaterniusVendorSource, /delete document\.textures/);
  assert.match(quaterniusVendorSource, /delete document\.samplers/);
  assert.match(quaterniusVendorSource, /packGlb/);
});

test("web build vendors and validates lightweight Quaternius decay models", () => {
  const packageJson = JSON.parse(packageSource);
  assert.match(packageJson.scripts["vendor:authored:decay"], /vendor-quaternius-decay\.mjs/);
  assert.match(packageJson.scripts["build:web"], /vendor:authored:decay/);
  assert.match(packageJson.scripts["build:web"], /validate-quaternius-decay\.mjs/);
});

test("model library exposes authored decay props through a single refresh channel", () => {
  assert.match(modelLibrarySource, /authored:decay-rubble/);
  assert.match(modelLibrarySource, /authored:decay-support/);
  assert.match(modelLibrarySource, /authored:decay-fence/);
  assert.match(modelLibrarySource, /authored:decay-.*return "decay"/s);
});

test("decay dressing prefers authored prop geometry and preserves procedural fallback", () => {
  assert.match(decayDressingSource, /authoredDecayMesh/);
  assert.match(decayDressingSource, /authored:decay-rubble/);
  assert.match(decayDressingSource, /authored:decay-support/);
  assert.match(decayDressingSource, /authored:decay-fence/);
  assert.match(decayDressingSource, /DECAY_GEOMETRY\.rubble/);
  assert.match(decayDressingSource, /MoyoDecayDressing/);
  assert.match(decayDressingSource, /refreshModelType.*decay/s);
});
