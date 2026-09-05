import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import { hexGridBoundaryCells, hexGridCenter } from "../dist-ts/src/hex-grid.js";
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

async function publicJson(env, path, init = {}) {
  const response = await worker.fetch(new Request(`https://moyo.example${path}`, init), env);
  const body = await response.json();
  return { response, body };
}

async function assignRegion(env, regionId) {
  await publicJson(env, `/api/world/snapshot?region=${regionId}`);
  const entry = env.REGIONS.entries.get(regionId);
  assert.ok(entry);
  await entry.state.ready;
  return entry;
}

async function depleteWood(entry) {
  const state = entry.object.runtime.snapshot();
  for (const tile of state.tiles) {
    if (tile.resource?.kind === "wood") tile.resource.amount = 0;
  }
  entry.object.runtime = new WorldRuntime({ state });
  await entry.object.persist();
}

test("one alarm reuses boundary halo edges when an interior scout follows", async () => {
  const env = environment();
  const source = await assignRegion(env, "garden-1");
  const east = await assignRegion(env, "garden-2");
  const northEast = await assignRegion(env, "garden-3");
  await depleteWood(east);
  await depleteWood(northEast);

  const state = source.object.runtime.snapshot();
  for (const tile of state.tiles) {
    if (tile.resource?.kind === "wood") tile.resource.amount = 0;
  }
  for (const agent of state.agents) agent.autonomy = false;
  state.tick = 24;

  const boundaryAgent = state.agents[0];
  const scoutAgent = state.agents[1];
  assert.ok(boundaryAgent);
  assert.ok(scoutAgent);
  const eastCells = hexGridBoundaryCells(state, "east");
  const boundary = eastCells[Math.floor(eastCells.length / 2)];
  assert.ok(boundary);
  const boundaryTile = state.tiles[boundary.y * state.width + boundary.x];
  assert.ok(boundaryTile);
  boundaryTile.terrain = "plain";

  boundaryAgent.position = { ...boundary };
  boundaryAgent.role = "woodcutter";
  boundaryAgent.autonomy = true;
  boundaryAgent.energy = 100;
  boundaryAgent.task = {
    source: "autonomy",
    issuedAtTick: 17,
    type: "gather",
    resource: "wood",
  };

  scoutAgent.position = hexGridCenter(state);
  scoutAgent.role = "woodcutter";
  scoutAgent.autonomy = true;
  scoutAgent.energy = 100;
  scoutAgent.task = {
    source: "autonomy",
    issuedAtTick: 18,
    type: "gather",
    resource: "wood",
  };

  source.object.runtime = new WorldRuntime({ state });
  await source.object.persist();
  env.REGIONS.edgeFetches.length = 0;

  await source.object.alarm();

  const reads = env.REGIONS.edgeFetches;
  assert.equal(reads.length, 2, "the two configured neighboring edges should be fetched only once");
  assert.equal(
    new Set(reads.map(({ regionId, direction }) => `${regionId}:${direction}`)).size,
    reads.length,
    "the interior scout must reuse edge snapshots already read for boundary handoff planning",
  );
  assert.deepEqual(
    new Set(reads.map(({ regionId }) => regionId)),
    new Set(["garden-2", "garden-3"]),
  );
});
