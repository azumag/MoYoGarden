import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import worker, { RegionDurableObject } from "../dist-ts/src/worker.js";

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

const directEnv = {
  WORLD_SEED: "424242",
  REGION_IDS: "garden-test",
  TICK_MS: "10000",
  OPEN_COMMANDS: "false",
};

function internalRequest(path) {
  return new Request(`https://moyo.example${path}`, {
    headers: { "x-moyo-region-internal": "garden-test" },
  });
}

test("terrain snapshot omits simulation-only payload at the Durable Object source", async () => {
  const ctx = new MemoryState();
  const object = new RegionDurableObject(ctx, directEnv);
  await ctx.ready;

  const full = await (await object.fetch(internalRequest("/api/world/snapshot"))).json();
  const terrain = await (await object.fetch(internalRequest("/api/world/snapshot?terrain=1"))).json();

  assert.equal(terrain.regionId, full.regionId);
  assert.equal(terrain.width, full.width);
  assert.equal(terrain.height, full.height);
  assert.equal(terrain.tick, full.tick);
  assert.equal(terrain.revision, full.revision);
  const activeFullTiles = full.tiles.filter((tile) => isHexGridCell(full, tile));
  assert.equal(terrain.tiles.length, activeFullTiles.length);
  assert.ok(terrain.tiles.length < full.tiles.length);
  assert.equal(terrain.tiles.every((tile) => isHexGridCell(full, tile)), true);
  assert.equal("agents" in terrain, false);
  assert.equal("structures" in terrain, false);
  assert.equal("events" in terrain, false);
  assert.equal("factions" in terrain, false);
  assert.equal(terrain.tiles.every((tile) => !("resource" in tile) && !("flowTo" in tile)), true);
});

test("terrain-only region windows request compact snapshots from each Durable Object", async () => {
  const seen = [];
  const state = {
    regionId: "garden-1",
    width: 40,
    height: 24,
    tick: 7,
    revision: 9,
    tiles: [{ x: 19, y: 11, terrain: "grass", elevation: 0.4, resource: { kind: "food", amount: 3 } }],
    agents: [{ id: "hidden-agent" }],
    structures: [{ id: "hidden-structure" }],
    events: [{ tick: 7, type: "hidden-event" }],
    factions: [{ id: "hidden-faction" }],
  };
  const env = {
    REGION_IDS: "garden-1",
    DEFAULT_REGION_ID: "garden-1",
    WORLD_SEED: "424242",
    REGIONS: {
      idFromName(name) { return name; },
      get() {
        return {
          async fetch(request) {
            seen.push(request.url);
            return new Response(JSON.stringify(state), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        };
      },
    },
  };

  const response = await worker.fetch(
    new Request("https://moyo.example/api/world/window?region=garden-1&radius=0&terrain=1"),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0]).searchParams.get("terrain"), "1");
  const payload = await response.json();
  assert.equal(payload.chunks.length, 1);
  assert.equal("agents" in payload.chunks[0].state, false);
  assert.equal("resource" in payload.chunks[0].state.tiles[0], false);
});
