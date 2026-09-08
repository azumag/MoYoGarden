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
    return { fetch: async (request) => {
      await entry.state.ready;
      return entry.object.fetch(request);
    } };
  }
}

function canonicalEnvWithoutRegionEnumeration() {
  const env = {
    WORLD_SEED: "424242",
    DEFAULT_REGION_ID: "garden-1",
    TICK_MS: "10000",
    OPEN_COMMANDS: "false",
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  };
  Object.defineProperty(env, "REGION_IDS", {
    get() { throw new Error("canonical public windows must not enumerate REGION_IDS"); },
  });
  env.REGIONS = new MemoryNamespace(env);
  return env;
}

test("canonical scoped metadata does not enumerate REGION_IDS", async () => {
  const env = canonicalEnvWithoutRegionEnumeration();
  const regionId = "hex-q12-r-7";
  const response = await worker.fetch(new Request(
    `https://moyo.example/api/meta?region=${regionId}&radius=1`,
  ), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.regions.length, 7);
  assert.equal(payload.regions.includes(regionId), true);
  assert.equal(payload.world.regionTopology.regions.length, 7);
});

test("canonical radius-one world window does not enumerate REGION_IDS", async () => {
  const env = canonicalEnvWithoutRegionEnumeration();
  const regionId = "hex-q12-r-7";
  const response = await worker.fetch(new Request(
    `https://moyo.example/api/world/window?region=${regionId}&radius=1`,
  ), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.centerRegion, regionId);
  assert.equal(payload.chunks.length, 7);
  assert.equal(env.REGIONS.entries.size, 7);
  assert.equal(payload.chunks.every((chunk) => chunk.axial && chunk.hexOrigin && chunk.globalCellOrigin), true);
});
