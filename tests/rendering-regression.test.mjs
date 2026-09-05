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
const quaterniusBuildingVendorSource = await readFile(
  new URL("../scripts/vendor-quaternius-buildings.mjs", import.meta.url),
  "utf8",
).catch(() => "");
const quaterniusBuildingValidatorSource = await readFile(
  new URL("../scripts/validate-quaternius-buildings.mjs", import.meta.url),
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

test("procedural support and fence fallbacks are grounded at y=0", () => {
  assert.match(decayDressingSource, /BoxGeometry\(0\.075,\s*0\.82,\s*0\.075\)\.translate\(0,\s*0\.41,\s*0\)/);
  assert.match(decayDressingSource, /BoxGeometry\(0\.92,\s*0\.42,\s*0\.06\)\.translate\(0,\s*0\.21,\s*0\)/);
});

test("Quaternius building shell vendor composes pinned texture-free modular architecture", () => {
  assert.match(quaterniusBuildingVendorSource, /db3df04d1e4714298a09510b26fb6de6645138a2/);
  assert.match(quaterniusBuildingVendorSource, /Wall_Plaster_Straight\.gltf/);
  assert.match(quaterniusBuildingVendorSource, /Wall_Plaster_Door_Flat\.gltf/);
  assert.match(quaterniusBuildingVendorSource, /Wall_Plaster_Window_Wide_Flat\.gltf/);
  assert.match(quaterniusBuildingVendorSource, /Wall_UnevenBrick_Straight\.gltf/);
  assert.match(quaterniusBuildingVendorSource, /Roof_Wooden_2x1\.gltf/);
  assert.match(quaterniusBuildingVendorSource, /gitBlobSha/);
  assert.match(quaterniusBuildingVendorSource, /packGlb/);
  assert.match(quaterniusBuildingVendorSource, /delete source\.images/);
  assert.match(quaterniusBuildingVendorSource, /delete source\.textures/);
  assert.match(quaterniusBuildingVendorSource, /delete source\.samplers/);
});

test("web build vendors and validates four Quaternius high LOD building shells", () => {
  const packageJson = JSON.parse(packageSource);
  assert.match(packageJson.scripts["vendor:authored:quaternius-buildings"], /vendor-quaternius-buildings\.mjs/);
  assert.match(packageJson.scripts["build:web"], /vendor:authored:quaternius-buildings/);
  assert.match(packageJson.scripts["build:web"], /validate-quaternius-buildings\.mjs/);
  assert.match(quaterniusBuildingValidatorSource, /camp\.glb/);
  assert.match(quaterniusBuildingValidatorSource, /storehouse\.glb/);
  assert.match(quaterniusBuildingValidatorSource, /market\.glb/);
  assert.match(quaterniusBuildingValidatorSource, /workshop\.glb/);
  assert.match(quaterniusBuildingValidatorSource, /256 \* 1024/);
  assert.match(quaterniusBuildingValidatorSource, /minY/);
});

test("high detail buildings prefer Quaternius shells while medium keeps KayKit fallback", () => {
  assert.match(modelLibrarySource, /AUTHORED_BUILDING_SHELL_BY_CHILD/);
  assert.match(modelLibrarySource, /authored:building-shell-camp/);
  assert.match(modelLibrarySource, /authored:building-shell-storehouse/);
  assert.match(modelLibrarySource, /authored:building-shell-market/);
  assert.match(modelLibrarySource, /authored:building-shell-workshop/);
  assert.match(modelLibrarySource, /detail === "high"[\s\S]*AUTHORED_BUILDING_SHELL_BY_CHILD/);
  assert.match(modelLibrarySource, /AUTHORED_BUILDING_BY_CHILD\[childName\]/);
  assert.match(modelLibrarySource, /resolveCloneSourceName/);
});

test("Quaternius shell loads refresh buildings and fit the existing building height contract", () => {
  assert.match(modelLibrarySource, /authored:building-shell-.*return "buildings"/s);
  assert.match(modelLibrarySource, /authored:building-shell-camp[\s\S]*1\.62/);
  assert.match(modelLibrarySource, /authored:building-shell-storehouse[\s\S]*1\.82/);
  assert.match(modelLibrarySource, /authored:building-shell-market[\s\S]*1\.72/);
  assert.match(modelLibrarySource, /authored:building-shell-workshop[\s\S]*1\.88/);
});
