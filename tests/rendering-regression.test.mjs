import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const modelLibrarySource = await readFile(new URL("../public/client/model-library.js", import.meta.url), "utf8");
const skyFixSource = await readFile(new URL("../public/client/sky-fix.js", import.meta.url), "utf8");
const bootSource = await readFile(new URL("../public/boot.js", import.meta.url), "utf8");
const decayDressingSource = await readFile(
  new URL("../public/client/decay-dressing.js", import.meta.url),
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

test("terrain adds instanced deadwood, rubble, and mud dressing", () => {
  assert.match(decayDressingSource, /MoyoDecayDressing/);
  assert.match(decayDressingSource, /MoyoDecayDeadwood/);
  assert.match(decayDressingSource, /MoyoDecayRubble/);
  assert.match(decayDressingSource, /MoyoDecayMudPatch/);
  assert.match(decayDressingSource, /InstancedMesh/);
});

test("buildings receive deterministic broken and rusted decay details", () => {
  assert.match(decayDressingSource, /MoyoDecayArchitecture/);
  assert.match(decayDressingSource, /MoyoBrokenPlank/);
  assert.match(decayDressingSource, /MoyoRustPatch/);
  assert.match(decayDressingSource, /hash2\(structure\.position\.x/);
});

test("boot loads decay dressing as an optional renderer extension", () => {
  assert.match(bootSource, /decay-dressing\.js/);
  assert.match(bootSource, /decay dressing failed/);
});
