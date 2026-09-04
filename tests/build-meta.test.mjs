import assert from "node:assert/strict";
import test from "node:test";
import { enrichMetaPayload } from "../dist-ts/src/worker-entry.js";

test("meta response exposes the deployed source commit", () => {
  const payload = enrichMetaPayload(
    { service: "moyo-garden", version: "0.2.0" },
    {
      commit: "0123456789abcdef0123456789abcdef01234567",
      branch: "main",
      source: "cloudflare-workers-builds",
    },
  );

  assert.deepEqual(payload.build, {
    commit: "0123456789abcdef0123456789abcdef01234567",
    branch: "main",
    source: "cloudflare-workers-builds",
  });
});
