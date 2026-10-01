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
  constructor(storage = new MemoryStorage()) {
    this.storage = storage;
    this.sockets = [];
    this.ready = Promise.resolve();
  }
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
    get() { throw new Error("single-region activity test should not fetch halo neighbors"); },
  },
};

function request(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-moyo-region-internal", "garden-test");
  return new Request(`https://moyo.example${path}`, { ...init, headers });
}

function assertAlarmNear(actual, expectedDelay, tolerance = 1_500) {
  const remaining = actual - Date.now();
  assert.ok(
    remaining >= expectedDelay - tolerance && remaining <= expectedDelay + tolerance,
    `expected alarm near ${expectedDelay}ms, got ${remaining}ms`,
  );
}

test("production region activity tiers map direct, hex-window prefetch, and cold access to active/warm/cold cadence", async () => {
  const ctx = new MemoryState();
  const object = new RegionDurableObject(ctx, env);
  await ctx.ready;

  const coldHealth = await (await object.fetch(request("/api/health"))).json();
  assert.equal(coldHealth.tickMode, "cold");
  assert.equal(coldHealth.effectiveTickMs, 600000);
  assert.equal(coldHealth.alarmScheduled, true);
  assert.equal(coldHealth.nextAlarmAt, ctx.storage.alarm);

  await object.alarm();
  assert.equal(ctx.storage.alarm, null, "caught-up cold regions should deep-idle without another alarm");
  const deepIdleHealth = await (await object.fetch(request("/api/health"))).json();
  assert.equal(deepIdleHealth.deepIdle, true);
  assert.equal(deepIdleHealth.alarmScheduled, false);
  assert.equal(deepIdleHealth.nextAlarmAt, null);

  const warmResponse = await object.fetch(request("/api/world/snapshot", {
    method: "HEAD",
    headers: { "x-moyo-prefetch": "1" },
  }));
  assert.equal(warmResponse.status, 204);
  assert.equal(await warmResponse.text(), "", "passive warm-up should not serialize a world snapshot");
  const warmHealth = await (await object.fetch(request("/api/health"))).json();
  assert.equal(warmHealth.tickMode, "warm");
  assert.equal(warmHealth.effectiveTickMs, 60000);
  assert.equal(warmHealth.alarmScheduled, true);
  assert.equal(warmHealth.nextAlarmAt, ctx.storage.alarm);
  assertAlarmNear(ctx.storage.alarm, 60000);

  await object.fetch(request("/api/world/snapshot"));
  const activeHealth = await (await object.fetch(request("/api/health"))).json();
  assert.equal(activeHealth.tickMode, "active");
  assert.equal(activeHealth.effectiveTickMs, 10000);
  assert.equal(activeHealth.alarmScheduled, true);
  assert.equal(activeHealth.nextAlarmAt, ctx.storage.alarm);
  assertAlarmNear(ctx.storage.alarm, 10000);
});
