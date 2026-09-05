import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as shared from "../public/client/shared.js";

const structuresSource = await readFile(new URL("../public/client/structures.js", import.meta.url), "utf8");
const modelLibrarySource = await readFile(new URL("../public/client/model-library.js", import.meta.url), "utf8");
const vendorSource = await readFile(new URL("../scripts/vendor-quaternius-buildings.mjs", import.meta.url), "utf8");

test("building silhouette variants are deterministic and distinct by building type", () => {
  assert.equal(typeof shared.buildingSilhouetteVariant, "function");
  const first = shared.buildingSilhouetteVariant("camp", { x: 11, y: 7 });
  const again = shared.buildingSilhouetteVariant("camp", { x: 11, y: 7 });
  assert.deepEqual(first, again);

  const signatures = ["camp", "storehouse", "market", "workshop"]
    .map((type) => shared.buildingSilhouetteVariant(type, { x: 11, y: 7 }))
    .map((variant) => JSON.stringify(variant));
  assert.equal(new Set(signatures).size, 4);
});

test("high LOD passes structure position for deterministic silhouette variation while mid stays unchanged", () => {
  assert.match(
    structuresSource,
    /detail:\s*"high",\s*variantPosition:\s*structure\.position/,
  );
  assert.doesNotMatch(
    structuresSource,
    /detail:\s*"mid",\s*variantPosition:/,
  );
});

test("runtime silhouette variation applies only to Quaternius high LOD shells", () => {
  assert.match(modelLibrarySource, /applyBuildingSilhouetteVariant/);
  assert.match(modelLibrarySource, /buildingSilhouetteVariant/);
  assert.match(
    modelLibrarySource,
    /detail\s*===\s*"high"[\s\S]*sourceName\.startsWith\("authored:building-shell-"\)[\s\S]*applyBuildingSilhouetteVariant/,
  );
});

test("Quaternius shells encode visibly different asymmetric silhouettes", () => {
  assert.match(vendorSource, /MoyoSilhouetteOpenSide/);
  assert.match(vendorSource, /MoyoSilhouetteAnnex/);
  assert.match(vendorSource, /MoyoSilhouetteCanopy/);
  assert.match(vendorSource, /MoyoSilhouetteStack/);
  assert.match(vendorSource, /silhouetteRole/);
});
