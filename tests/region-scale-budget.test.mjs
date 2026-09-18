import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist-ts/src/worker-entry.js";

class CountingNamespace {
  constructor() {
    this.fetches = 0;
    this.regionIds = new Set();
  }
  idFromName(name) { return name; }
  get(id) {
    return {
      fetch: async (request) => {
        this.fetches += 1;
        this.regionIds.add(id);
        const regionId = request.headers.get("x-moyo-region-internal") ?? id;
        return new Response(JSON.stringify({
          regionId,
          width: 40,
          height: 24,
          tick: 0,
          revision: 0,
          tiles: [],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
  }
}

function configuredIds(count) {
  const ids = ["garden-1", "garden-2", "garden-3"];
  for (let index = ids.length; index < count; index += 1) {
    ids.push(`hex-q${index + 10}-r${-(index + 3)}`);
  }
  return ids.join(",");
}

function baseEnv(regionIds, namespace = new CountingNamespace()) {
  return {
    DEFAULT_REGION_ID: "garden-1",
    REGION_IDS: regionIds,
    WORLD_SEED: "424242",
    TICK_MS: "10000",
    OPEN_COMMANDS: "false",
    REGIONS: namespace,
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  };
}

test("radius-one production window keeps its request budget constant from 19 to 1000 configured regions", async (t) => {
  const scales = [19, 61, 127, 331, 1000];
  const rows = [];
  for (const scale of scales) {
    const namespace = new CountingNamespace();
    const env = baseEnv(configuredIds(scale), namespace);
    const started = performance.now();
    const response = await worker.fetch(new Request(
      "https://moyo.example/api/world/window?region=garden-1&radius=1&terrain=1",
    ), env);
    const elapsedMs = performance.now() - started;
    assert.equal(response.status, 200);
    const payload = await response.json();
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
    assert.equal(payload.chunks.length, 7);
    assert.equal(namespace.fetches, 7);
    assert.equal(namespace.regionIds.size, 7);
    rows.push({ scale, doFetches: namespace.fetches, payloadBytes, elapsedMs: Number(elapsedMs.toFixed(3)) });
  }
  assert.deepEqual(new Set(rows.map((row) => row.doFetches)), new Set([7]));
  assert.equal(new Set(rows.map((row) => row.payloadBytes)).size, 1);
  t.diagnostic(`region-scale-budget ${JSON.stringify(rows)}`);
});

test("unprojectable canonical coordinates fail closed instead of throwing during public routing", async () => {
  const env = baseEnv("garden-1,garden-2,garden-3");
  const regionId = "hex-q9007199254740991-r0";

  const meta = await worker.fetch(new Request(
    `https://moyo.example/api/meta?region=${regionId}&radius=1`,
  ), env);
  assert.equal(meta.status, 404);
  assert.deepEqual(await meta.json(), { error: "unknown or disabled region" });

  const window = await worker.fetch(new Request(
    `https://moyo.example/api/world/window?region=${regionId}&radius=1`,
  ), env);
  assert.equal(window.status, 404);
  assert.deepEqual(await window.json(), { error: "unknown or disabled region" });
});
