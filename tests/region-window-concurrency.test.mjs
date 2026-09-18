import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist-ts/src/worker-entry.js";

class TrackingNamespace {
  constructor(delayMs = 5) {
    this.delayMs = delayMs;
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.requests = 0;
  }

  idFromName(name) { return name; }

  get(id) {
    return {
      fetch: async (request) => {
        this.requests += 1;
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, this.delayMs));
          const regionId = request.headers.get("x-moyo-region-internal") ?? id;
          return new Response(JSON.stringify({
            worldId: "garden",
            regionId,
            seed: 424242,
            width: 40,
            height: 24,
            tick: 0,
            revision: 0,
            tiles: [],
            agents: [],
            factions: [],
            structures: [],
            events: [],
            processedCommandIds: [],
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } finally {
          this.inFlight -= 1;
        }
      },
    };
  }
}

test("radius-four sparse window bounds simultaneous region snapshot fetches", async () => {
  const regions = new TrackingNamespace();
  const env = {
    DEFAULT_REGION_ID: "hex-q10-r-10",
    WORLD_SEED: "424242",
    TICK_MS: "10000",
    OPEN_COMMANDS: "false",
    REGIONS: regions,
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  };
  Object.defineProperty(env, "REGION_IDS", {
    get() { throw new Error("canonical sparse window must not enumerate REGION_IDS"); },
  });

  const response = await worker.fetch(new Request(
    "https://moyo.example/api/world/window?radius=4",
  ), env);
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.centerRegion, "hex-q10-r-10");
  assert.equal(payload.chunks.length, 61);
  assert.equal(regions.requests, 61);
  assert.ok(
    regions.maxInFlight <= 6,
    `expected at most 6 simultaneous snapshot reads, got ${regions.maxInFlight}`,
  );
  assert.ok(regions.maxInFlight >= 2, "window aggregation should retain useful parallelism");
  assert.equal(payload.chunks.every((chunk) => chunk.state !== undefined), true);
});
