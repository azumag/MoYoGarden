import assert from "node:assert/strict";
import test from "node:test";
import { RegionDurableObject } from "../dist-ts/src/autonomy-region.js";

class MemoryStorage {
  constructor() { this.values = new Map(); this.alarm = null; }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value instanceof Date ? value.getTime() : value; }
  async deleteAlarm() { this.alarm = null; }
}

class MemoryState {
  constructor() { this.storage = new MemoryStorage(); this.sockets = []; this.ready = Promise.resolve(); }
  blockConcurrencyWhile(callback) { this.ready = callback(); return this.ready; }
  acceptWebSocket(socket) { this.sockets.push(socket); }
  getWebSockets() { return [...this.sockets]; }
}

const env = {
  WORLD_SEED: "424242",
  REGION_IDS: "garden-test",
  TICK_MS: "10000",
  OPEN_COMMANDS: "false",
  COMMAND_TOKEN: "command-secret",
  ADMIN_TOKEN: "admin-secret",
  REGIONS: {
    idFromName(name) { return name; },
    get() { throw new Error("single-region catch-up test should not fetch neighbors"); },
  },
};

function request(path) {
  return new Request(`https://moyo.example${path}`, {
    headers: { "x-moyo-region-internal": "garden-test" },
  });
}

test("cold alarm catches up bounded virtual ticks without skipping simulation cadence", async () => {
  const originalNow = Date.now;
  let now = 1_800_001_000_000;
  Date.now = () => now;
  try {
    const ctx = new MemoryState();
    const object = new RegionDurableObject(ctx, env);
    await ctx.ready;
    await object.fetch(request("/api/world/snapshot"));
    const assignedAt = ctx.storage.values.get("region").lastSimulatedAt;
    assert.equal(assignedAt, now);

    now += 600_000;
    await object.alarm();

    const state = await (await object.fetch(request("/api/world/snapshot"))).json();
    assert.equal(state.tick, 60, "ten cold minutes should execute sixty 10-second virtual ticks");
    assert.equal(ctx.storage.values.get("region").lastSimulatedAt, now);
    const health = await (await object.fetch(request("/api/health"))).json();
    assert.equal(health.virtualTicksDue, 0);
    assert.equal(health.virtualTicksRunnable, 0);
  } finally {
    Date.now = originalNow;
  }
});


test("capped catch-up preserves remaining debt and schedules a prompt retry", async () => {
  const originalNow = Date.now;
  let now = 1_800_002_000_000;
  Date.now = () => now;
  try {
    const ctx = new MemoryState();
    const object = new RegionDurableObject(ctx, env);
    await ctx.ready;
    await object.fetch(request("/api/world/snapshot"));
    const assignedAt = ctx.storage.values.get("region").lastSimulatedAt;

    now += 3_600_000;
    await object.alarm();

    const state = await (await object.fetch(request("/api/world/snapshot"))).json();
    assert.equal(state.tick, 60);
    assert.equal(ctx.storage.values.get("region").lastSimulatedAt, assignedAt + 600_000);
    const health = await (await object.fetch(request("/api/health"))).json();
    assert.equal(health.virtualTicksDue, 300);
    assert.equal(health.virtualTicksRunnable, 60);
    assert.equal(health.virtualTicksCapped, true);
    assert.equal(ctx.storage.alarm, now + 10_000, "remaining debt should retry at base tick cadence");
  } finally {
    Date.now = originalNow;
  }
});