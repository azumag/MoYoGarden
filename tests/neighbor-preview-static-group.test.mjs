import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../public/client/hex-neighbor-preview.js", import.meta.url),
  "utf8",
);

test("neighbor preview chunk roots keep static local transforms", () => {
  const start = source.indexOf("function upgradeNeighborPreview");
  const end = source.indexOf("const baseMarkShadowsDirty", start);
  const body = source.slice(start, end);

  const position = body.indexOf("group.position.set(placement.hexOffset.x, 0, placement.hexOffset.z)");
  const update = body.indexOf("group.updateMatrix()");
  const freeze = body.indexOf("group.matrixAutoUpdate = false");
  const append = body.indexOf("groups.push(group)");

  assert.ok(position >= 0, "chunk placement should remain expressed as a local group offset");
  assert.ok(update > position, "the final static chunk offset must be composed into its local matrix");
  assert.ok(freeze > update, "matrixAutoUpdate should be disabled only after composing the offset");
  assert.ok(append > freeze, "the frozen chunk root should be finalized before it is attached to the preview");
});
