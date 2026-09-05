import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import { hexGridBoundaryCells, hexGridCenter, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";

const CLAIMS_KEY = "handoff:autonomy:claims:v1";
const TRAVEL_KEY = "handoff:autonomy:travel:v1";

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

function environment() {
  const env = {
    WORLD_SEED: "737373",
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

function depleteWood(state) {
  for (const tile of state.tiles) {
    if (tile.resource?.kind === "wood") tile.resource.amount = 0;
    if (isHexGridCell(state, tile) && tile.terrain !== "water") tile.terrain = "plain";
  }
}

function placeBoundaryWood(state, direction, amount) {
  const cells = hexGridBoundaryCells(state, direction);
  const position = cells[Math.floor(cells.length / 2)];
  assert.ok(position);
  const tile = state.tiles[position.y * state.width + position.x];
  assert.ok(tile);
  tile.terrain = "forest";
  tile.resource = { kind: "wood", amount, maxAmount: amount };
}

test("persisted supply claims keep the next scout from double-booking the same neighbor", async () => {
  const env = environment();
  const source = await assignRegion(env, "garden-1");
  const east = await assignRegion(env, "garden-2");
  const northEast = await assignRegion(env, "garden-3");

  const sourceState = source.object.runtime.snapshot();
  depleteWood(sourceState);
  for (const candidate of sourceState.agents) candidate.autonomy = false;
  const agent = sourceState.agents[0];
  assert.ok(agent);
  sourceState.tick = 24;
  agent.autonomy = true;
  agent.position = hexGridCenter(sourceState);
  agent.role = "woodcutter";
  agent.capacity = 12;
  agent.inventory = { wood: 0, stone: 0, food: 0 };
  agent.energy = 100;
  agent.task = {
    source: "autonomy",
    issuedAtTick: 20,
    type: "gather",
    resource: "wood",
  };
  source.object.runtime = new WorldRuntime({ state: sourceState });
  await source.object.persist();

  const eastState = east.object.runtime.snapshot();
  depleteWood(eastState);
  placeBoundaryWood(eastState, "west", 12);
  east.object.runtime = new WorldRuntime({ state: eastState });
  await east.object.persist();

  const northEastState = northEast.object.runtime.snapshot();
  depleteWood(northEastState);
  placeBoundaryWood(northEastState, "southWest", 4);
  northEast.object.runtime = new WorldRuntime({ state: northEastState });
  await northEast.object.persist();

  await source.state.storage.put(CLAIMS_KEY, [{
    claimId: "prior-east-expedition",
    resource: "wood",
    direction: "east",
    neighborRegionId: "garden-2",
    amount: 10,
    expiresAtTick: 84,
  }]);

  await source.object.alarm();

  const travel = await source.state.storage.get(TRAVEL_KEY);
  assert.ok(travel);
  assert.equal(
    travel.neighborRegionId,
    "garden-3",
    "the persisted east claim should leave the north-east supply as the better available expedition",
  );
});
