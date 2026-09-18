import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.alarm = null;
  }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value instanceof Date ? value.getTime() : value; }
  async deleteAlarm() { this.alarm = null; }
}

class MemoryState {
  constructor() {
    this.storage = new MemoryStorage();
    this.sockets = [];
    this.ready = Promise.resolve();
  }
  blockConcurrencyWhile(callback) {
    const result = Promise.resolve().then(callback);
    this.ready = result.catch(() => {});
    return result;
  }
  acceptWebSocket(socket) { this.sockets.push(socket); }
  getWebSockets() { return [...this.sockets]; }
}

class CountingNamespace {
  constructor(env) {
    this.env = env;
    this.entries = new Map();
    this.edgeFetches = [];
  }
  idFromName(name) { return name; }
  get(id) {
    let entry = this.entries.get(id);
    if (!entry) {
      const state = new MemoryState();
      const object = new RegionDurableObject(state, this.env);
      entry = { state, object };
      this.entries.set(id, entry);
    }
    return {
      fetch: async (request) => {
        await entry.state.ready;
        const url = new URL(request.url);
        if (url.pathname === "/api/internal/halo/edge") {
          this.edgeFetches.push({
            regionId: id,
            direction: url.searchParams.get("direction"),
          });
        }
        return entry.object.fetch(request);
      },
    };
  }
}

function configuredIds(count) {
  const ids = ["garden-1", "garden-2", "garden-3"];
  for (let index = ids.length; index < count; index += 1) {
    ids.push(`hex-q${index + 1000}-r${-(index + 2000)}`);
  }
  return ids.join(",");
}

function environment(regionIds) {
  const env = {
    WORLD_SEED: "424242",
    REGION_IDS: regionIds,
    TICK_MS: "10000",
    OPEN_COMMANDS: "false",
    COMMAND_TOKEN: "command-secret",
    ADMIN_TOKEN: "admin-secret",
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  };
  env.REGIONS = new CountingNamespace(env);
  return env;
}

async function halo(env, regionId) {
  const response = await worker.fetch(new Request(
    `https://moyo.example/api/world/halo?region=${encodeURIComponent(regionId)}`,
  ), env);
  return { response, body: await response.json() };
}

test("canonical depth-one halo keeps its DO fan-out constant from 19 to 1000 configured regions", async (t) => {
  const scales = [19, 61, 127, 331, 1000];
  const rows = [];
  const centerRegion = "hex-q12-r-7";

  for (const scale of scales) {
    const env = environment(configuredIds(scale));
    const started = performance.now();
    const { response, body } = await halo(env, centerRegion);
    const elapsedMs = performance.now() - started;
    const payloadBytes = Buffer.byteLength(JSON.stringify(body));

    assert.equal(response.status, 200);
    assert.equal(body.centerRegion, centerRegion);
    assert.equal(body.depth, 1);
    assert.equal(body.expectedLinks, 138);
    assert.equal(body.materializedLinks, 138);
    assert.equal(body.neighborEdges.length, 6);
    assert.equal(env.REGIONS.edgeFetches.length, 6);
    assert.equal(new Set(env.REGIONS.edgeFetches.map((entry) => entry.regionId)).size, 6);
    assert.equal(env.REGIONS.entries.size, 7, "center plus exactly six halo neighbors may materialize");

    rows.push({
      scale,
      edgeFetches: env.REGIONS.edgeFetches.length,
      materializedRegions: env.REGIONS.entries.size,
      payloadBytes,
      elapsedMs: Number(elapsedMs.toFixed(3)),
    });
  }

  assert.deepEqual(new Set(rows.map((row) => row.edgeFetches)), new Set([6]));
  assert.deepEqual(new Set(rows.map((row) => row.materializedRegions)), new Set([7]));
  assert.equal(new Set(rows.map((row) => row.payloadBytes)).size, 1);
  t.diagnostic(`region-halo-scale-budget ${JSON.stringify(rows)}`);
});
