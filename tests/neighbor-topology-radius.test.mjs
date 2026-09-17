import assert from "node:assert/strict";
import test from "node:test";

const previewModule = await import("../public/client/hex-neighbor-preview.js");

test("neighbor preview fallback topology fetch stays within the radius-1 window", async (t) => {
  const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, "location");
  const originalLocation = globalThis.location;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (hadLocation) globalThis.location = originalLocation;
    else delete globalThis.location;
  });

  globalThis.location = { protocol: "https:" };
  const requestedCenter = "hex-q77-r-77";
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({
      world: {
        regionTopology: {
          regions: [{ id: requestedCenter }],
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const topology = await previewModule.ensureHexNeighborTopology(requestedCenter);
  assert.deepEqual(topology.map((entry) => entry.id), [requestedCenter]);
  assert.equal(urls.length, 1);
  const requestedUrl = new URL(urls[0], "https://moyo.bluemoon.works");
  assert.equal(requestedUrl.searchParams.get("radius"), "1", "preview fallback must not request the unused ring-2 topology");
});
