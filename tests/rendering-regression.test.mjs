import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const modelLibrarySource = await readFile(new URL("../public/client/model-library.js", import.meta.url), "utf8");
const skyFixSource = await readFile(new URL("../public/client/sky-fix.js", import.meta.url), "utf8");
const terrainSource = await readFile(new URL("../public/client/terrain.js", import.meta.url), "utf8");
const structuresSource = await readFile(new URL("../public/client/structures.js", import.meta.url), "utf8");

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
  assert.match(terrainSource, /MoyoDecayDressing/);
  assert.match(terrainSource, /Deadwood/);
  assert.match(terrainSource, /Rubble/);
  assert.match(terrainSource, /MudPatch/);
  assert.match(terrainSource, /InstancedMesh/);
});

test("buildings receive deterministic broken and rusted decay details", () => {
  assert.match(structuresSource, /MoyoDecayArchitecture/);
  assert.match(structuresSource, /MoyoBrokenPlank/);
  assert.match(structuresSource, /MoyoRustPatch/);
  assert.match(structuresSource, /hash2\(structure\.position\.x/);
});
