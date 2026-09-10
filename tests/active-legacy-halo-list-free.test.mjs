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

test("active legacy halo materialization does not enumerate REGION_IDS", async () => {
  let regionListReads = 0;
  const env = {
    WORLD_SEED: "424242",
    TICK_MS: "10000",
    OPEN_COMMANDS: "false",
    COMMAND_TOKEN: "command-secret",
    ADMIN_TOKEN: "admin-secret",
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  };
  Object.defineProperty(env, "REGION_IDS", {
    configurable: true,
    get() {
      regionListReads += 1;
      throw new Error("active legacy halo must not enumerate REGION_IDS");
    },
  });
  env.REGIONS = new MemoryNamespace(env);

  const state = new MemoryState();
  const object = new RegionDurableObject(state, env);
  await state.ready;
  const response = await object.fetch(new Request("https://moyo.example/api/world/halo", {
    headers: { "x-moyo-region-internal": "garden-1" },
  }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.centerRegion, "garden-1");
  assert.equal(payload.expectedLinks, 138);
  assert.equal(payload.materializedLinks, 138);
  assert.equal(payload.neighborEdges.length, 6);
  assert.equal(regionListReads, 0);
});
