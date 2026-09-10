import assert from "node:assert/strict";
import test from "node:test";
import { RegionDurableObject } from "../dist-ts/src/halo-region.js";

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

class MemoryNamespace {
  constructor(env) {
    this.env = env;
    this.entries = new Map();
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
        return entry.object.fetch(request);
      },
    };
  }
}

function healthRequest(regionId) {
  return new Request("https://moyo.example/api/health", {
    headers: { "x-moyo-region-internal": regionId },
  });
}

function createEnv() {
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

async function assign(stub, regionId) {
  const response = await stub.fetch(healthRequest(regionId));
  assert.equal(response.status, 200, `expected ${regionId} to be assigned`);
}

test("warm and cold persisted legacy halo stay bounded without enumerating REGION_IDS", async () => {
  const env = createEnv();
  const sourceState = new MemoryState();
  const source = new RegionDurableObject(sourceState, env);
  await sourceState.ready;

  await assign({ fetch: (request) => source.fetch(request) }, "garden-1");
  await assign(env.REGIONS.get("garden-2"), "garden-2");
  await assign(env.REGIONS.get("garden-3"), "garden-3");

  let regionListReads = 0;
  Object.defineProperty(env, "REGION_IDS", {
    configurable: true,
    get() {
      regionListReads += 1;
      throw new Error("background persisted legacy halo must not enumerate REGION_IDS");
    },
  });

  source.lastDirectActivityAt = 0;
  source.lastWarmActivityAt = Date.now();
  assert.equal(source.activityTier(), "warm");
  const warm = await source.materializeHaloForState(source.runtime.snapshot());
  assert.equal(warm.links.length, 2 * 23);
  assert.equal(warm.halo.length, 2 * 23);
  assert.equal(warm.edges.length, 2);
  assert.deepEqual(
    [...new Set(warm.links.map((entry) => entry.neighborRegionId))].sort(),
    ["garden-2", "garden-3"],
  );

  source.lastWarmActivityAt = 0;
  assert.equal(source.activityTier(), "cold");
  const cold = await source.materializeHaloForState(source.runtime.snapshot());
  assert.equal(cold.links.length, 2 * 23);
  assert.equal(cold.halo.length, 2 * 23);
  assert.equal(cold.edges.length, 2);
  assert.deepEqual(
    [...new Set(cold.links.map((entry) => entry.neighborRegionId))].sort(),
    ["garden-2", "garden-3"],
  );
  assert.equal(regionListReads, 0);
});
