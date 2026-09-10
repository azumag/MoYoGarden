import assert from "node:assert/strict";
import test from "node:test";
import { RegionDurableObject } from "../dist-ts/src/move-handoff-region.js";
import {
  HEX_GRID_DIRECTION_STEPS,
  hexGridBoundaryCells,
} from "../dist-ts/src/hex-grid.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";

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

test("cross-region move interception does not coerce string coordinates into a handoff", async () => {
  const state = new MemoryState();
  let regionLookups = 0;
  const env = {
    WORLD_SEED: "424242",
    REGION_IDS: "garden-1,garden-2,garden-3",
    OPEN_COMMANDS: "true",
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    REGIONS: {
      idFromName(name) { return name; },
      get() {
        regionLookups += 1;
        throw new Error("type-invalid move target must not start a cross-region handoff");
      },
    },
  };
  const object = new RegionDurableObject(state, env);
  await state.ready;

  const assigned = await object.fetch(new Request("https://moyo.example/api/health", {
    headers: { "x-moyo-region-internal": "garden-1" },
  }));
  assert.equal(assigned.status, 200);

  const world = object.runtime.snapshot();
  const agent = world.agents[0];
  assert.ok(agent);
  const cell = hexGridBoundaryCells(world, "east")[11];
  assert.ok(cell);
  const sourceTile = world.tiles[cell.y * world.width + cell.x];
  assert.ok(sourceTile);
  sourceTile.terrain = "plain";
  delete sourceTile.resource;
  agent.position = { ...cell };
  agent.autonomy = false;
  delete agent.task;
  object.runtime = new WorldRuntime({ state: world });

  const step = HEX_GRID_DIRECTION_STEPS.east;
  const response = await object.fetch(new Request(
    `https://moyo.example/api/agents/${encodeURIComponent(agent.id)}/commands`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-moyo-region-internal": "garden-1",
      },
      body: JSON.stringify({
        id: "string-coordinate-move",
        type: "move",
        target: {
          x: String(cell.x + step.x),
          y: cell.y + step.y,
        },
      }),
    },
  ));

  assert.equal(response.status, 400);
  assert.equal(regionLookups, 0);
  const receipt = await response.json();
  assert.equal(receipt.accepted, false);
  assert.match(receipt.reason, /target must be an object with integer x and y/);
});
