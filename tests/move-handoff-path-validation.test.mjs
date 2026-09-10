import assert from "node:assert/strict";
import test from "node:test";
import { RegionDurableObject } from "../dist-ts/src/move-handoff-region.js";

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
    this.ready = Promise.resolve();
  }
  blockConcurrencyWhile(callback) {
    const result = Promise.resolve().then(callback);
    this.ready = result.catch(() => {});
    return result;
  }
  acceptWebSocket() {}
  getWebSockets() { return []; }
}

test("malformed percent encoding in an agent command path returns 400 instead of throwing", async () => {
  const state = new MemoryState();
  const env = {
    WORLD_SEED: "424242",
    REGION_IDS: "garden-1,garden-2,garden-3",
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    REGIONS: {
      idFromName(name) { return name; },
      get() { throw new Error("malformed path must not route to another region"); },
    },
  };
  const object = new RegionDurableObject(state, env);
  await state.ready;

  const response = await object.fetch(new Request(
    "https://moyo.example/api/agents/%E0%A4%A/commands",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "malformed-agent-path",
        type: "move",
        target: { x: 1, y: 1 },
      }),
    },
  ));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid agent id encoding" });
});
