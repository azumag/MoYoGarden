import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const previewSource = await readFile(
  new URL("../public/client/hex-neighbor-preview.js", import.meta.url),
  "utf8",
);

test("neighbor preview fallback topology fetch stays within the radius-1 window", () => {
  assert.match(
    previewSource,
    /regionMetaUrl\(requestedCenter,\s*1\)/,
    "preview fallback must request only the center plus six immediate neighbors",
  );
  assert.doesNotMatch(
    previewSource,
    /regionMetaUrl\(requestedCenter,\s*2\)/,
    "preview fallback must not request the unused ring-2 topology",
  );
});
