import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";

class MemoryStorage {
  constructor() { this.values = new Map(); this.alarm = null; }
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

class MemoryNamespace {
  constructor(env) { this.env = env; this.entries = new Map(); }
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
        return entry.object.fetch(request);
      },
    };
  }
}

function environment() {
  const env = {
    WORLD_SEED: "424242",
    REGION_IDS: "garden-1,garden-2,garden-3",
    TICK_MS: "10000",
    OPEN_COMMANDS: "false",
    COMMAND_TOKEN: "command-secret",
    ADMIN_TOKEN: "admin-secret",
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  };
  env.REGIONS = new MemoryNamespace(env);
  return env;
}

async function call(env, path, init = {}) {
  const response = await worker.fetch(new Request(`https://moyo.example${path}`, init), env);
  const body = await response.json();
  return { response, body };
}

test("public Worker never proxies internal halo edge routes", async () => {
  const env = environment();
  const result = await call(env, "/api/internal/halo/edge?region=garden-1&direction=east");
  assert.equal(result.response.status, 404);
  assert.equal(env.REGIONS.entries.size, 0);
});

test("active legacy world halo expands to the full six-neighbor dynamic ring", async () => {
  const env = environment();
  const result = await call(env, "/api/world/halo?region=garden-1");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.centerRegion, "garden-1");
  assert.equal(result.body.depth, 1);
  assert.equal(result.body.expectedLinks, 138);
  assert.equal(result.body.materializedLinks, 138);
  assert.deepEqual(
    result.body.neighborEdges.map((entry) => entry.regionId).sort(),
    [
      "garden-2",
      "garden-3",
      "hex-q-1-r0",
      "hex-q-1-r1",
      "hex-q0-r-1",
      "hex-q0-r1",
    ].sort(),
  );
  assert.ok(result.body.neighborEdges.every((entry) => entry.tiles === 23));
  assert.ok(result.body.halo.every((entry) => entry.sourceRegionId === "garden-1"));
  assert.deepEqual(
    [...new Set(result.body.halo.map((entry) => entry.direction))].sort(),
    ["east", "northEast", "northWest", "southEast", "southWest", "west"].sort(),
  );

  const targetSnapshots = new Map();
  for (const regionId of result.body.neighborEdges.map((entry) => entry.regionId)) {
    targetSnapshots.set(regionId, (await call(env, `/api/world/snapshot?region=${regionId}`)).body);
  }
  for (const ghost of result.body.halo) {
    const target = targetSnapshots.get(ghost.neighborRegionId);
    assert.ok(target);
    const tile = target.tiles[ghost.neighborPosition.y * target.width + ghost.neighborPosition.x];
    assert.ok(tile);
    assert.deepEqual(ghost.tile, tile);
  }
});

test("dynamic halo edge sampling keeps all six passive neighbors cold", async () => {
  const env = environment();
  const halo = await call(env, "/api/world/halo?region=garden-1");
  for (const regionId of halo.body.neighborEdges.map((entry) => entry.regionId)) {
    const health = await call(env, `/api/health?region=${regionId}`);
    assert.equal(health.response.status, 200);
    assert.equal(health.body.tickMode, "cold");
    assert.equal(health.body.effectiveTickMs, 600000);
  }
});


test("canonical world halo materializes a bounded six-neighbor dynamic ring", async () => {
  const env = environment();
  const result = await call(env, "/api/world/halo?region=hex-q0-r1");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.centerRegion, "hex-q0-r1");
  assert.equal(result.body.depth, 1);
  assert.equal(result.body.expectedLinks, 138);
  assert.equal(result.body.materializedLinks, 138);
  assert.equal(result.body.neighborEdges.length, 6);
  assert.ok(result.body.neighborEdges.every((entry) => entry.tiles === 23));
  assert.deepEqual(
    result.body.neighborEdges.map((entry) => entry.regionId).sort(),
    ["garden-1", "garden-2", "hex-q-1-r1", "hex-q-1-r2", "hex-q0-r2", "hex-q1-r1"].sort(),
  );
  assert.equal(env.REGIONS.entries.size, 7, "center plus exactly six neighbors may materialize");

  for (const regionId of result.body.neighborEdges.map((entry) => entry.regionId)) {
    const health = await call(env, `/api/health?region=${regionId}`);
    assert.equal(health.response.status, 200);
    assert.equal(health.body.tickMode, "cold", `${regionId} must stay cold after internal halo sampling`);
  }
});
