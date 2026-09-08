import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import { HEX_GRID_DIRECTION_STEPS, hexGridBoundaryCells, hexGridCenter, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { buildConfiguredHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { regionCellTransition } from "../dist-ts/src/region-topology.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";

const CLAIMS_KEY = "handoff:autonomy:claims:v1";
const HANDOFF_KEY = "handoff:autonomy:v1";
const TRAVEL_KEY = "handoff:autonomy:travel:v1";
const ARRIVAL_CLAIMS_KEY = "handoff:autonomy:arrival-claims:v1";

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
    if (isHexGridCell(state, tile)) tile.terrain = "plain";
  }
}

function placeLinkedBoundaryWood(sourceState, targetState, direction, targetRegionId, amount) {
  const link = buildConfiguredHexHaloLinks(
    sourceState,
    ["garden-1", "garden-2", "garden-3"],
    sourceState.regionId,
  ).find((entry) => entry.direction === direction && entry.neighborRegionId === targetRegionId);
  assert.ok(link);
  const tile = targetState.tiles[link.neighborPosition.y * targetState.width + link.neighborPosition.x];
  assert.ok(tile);
  tile.terrain = "forest";
  tile.resource = { kind: "wood", amount, maxAmount: amount };
  return link;
}


const TRAVELS_KEY = "handoff:autonomy:travel:v2";

async function expeditionFixture(supply = 8) {
  const env = environment();
  const source = await assignRegion(env, "garden-1");
  const neighbors = await Promise.all([
    "garden-2", "garden-3", "hex-q-1-r0", "hex-q-1-r1", "hex-q0-r-1", "hex-q0-r1",
  ].map((id) => assignRegion(env, id)));
  const state = source.object.runtime.snapshot();
  depleteWood(state);
  state.tick = 24;
  for (const agent of state.agents) agent.autonomy = false;
  const scouts = state.agents.slice(0, 4);
  assert.equal(scouts.length, 4);
  for (const agent of scouts) {
    agent.autonomy = true;
    agent.role = "woodcutter";
    agent.position = hexGridCenter(state);
    agent.energy = 100;
    agent.capacity = 2;
    agent.inventory = { wood: 0, stone: 0, food: 0 };
    agent.task = { source: "autonomy", type: "gather", resource: "wood", issuedAtTick: 24 };
  }
  let link;
  for (const neighbor of neighbors) {
    const other = neighbor.object.runtime.snapshot();
    depleteWood(other);
    for (const agent of other.agents) agent.autonomy = false;
    if (other.regionId === "garden-2") {
      link = placeLinkedBoundaryWood(state, other, "east", "garden-2", supply);
    }
    neighbor.object.runtime = new WorldRuntime({ state: other });
    await neighbor.object.persist();
  }
  source.object.runtime = new WorldRuntime({ state });
  await source.object.persist();
  return { env, source, east: neighbors[0], scouts, link };
}

test("one scout cadence starts at most three independently reserved expeditions", async () => {
  const { source } = await expeditionFixture();
  await source.object.alarm();
  const travels = await source.state.storage.get(TRAVELS_KEY);
  assert.equal(travels?.length, 3);
  assert.equal(new Set(travels.map((x) => x.agentId)).size, 3);
  const claims = await source.state.storage.get(CLAIMS_KEY);
  assert.equal(claims.length, 3);
  assert.equal(claims.reduce((sum, x) => sum + x.amount, 0), 6);
  const before = source.object.runtime.snapshot();
  await source.object.alarm();
  const after = source.object.runtime.snapshot();
  assert.equal((await source.state.storage.get(TRAVELS_KEY)).length, 3);
  for (const travel of travels) {
    const old = before.agents.find((x) => x.id === travel.agentId);
    const current = after.agents.find((x) => x.id === travel.agentId);
    assert.notDeepEqual(current.position, old.position, "every expedition must keep moving");
  }
});

test("concurrent scouts cannot reserve the same finite supply twice", async () => {
  const { source } = await expeditionFixture(2);
  await source.object.alarm();
  assert.equal((await source.state.storage.get(TRAVELS_KEY))?.length, 1);
  const claims = await source.state.storage.get(CLAIMS_KEY);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].amount, 2);
});

test("interrupting one expedition preserves other trips and the external task", async () => {
  const { source } = await expeditionFixture();
  await source.object.alarm();
  const trips = await source.state.storage.get(TRAVELS_KEY);
  assert.equal(trips?.length, 3);
  const cancelled = trips[0];
  const state = source.object.runtime.snapshot();
  const agent = state.agents.find((x) => x.id === cancelled.agentId);
  const external = { source: "external", issuedAtTick: state.tick, type: "move", target: { x: 19, y: 15 } };
  agent.task = external;
  source.object.runtime = new WorldRuntime({ state });
  await source.object.alarm();
  const remaining = await source.state.storage.get(TRAVELS_KEY);
  assert.equal(remaining.length, 2);
  assert.equal(remaining.some((x) => x.agentId === cancelled.agentId), false);
  assert.equal((await source.state.storage.get(CLAIMS_KEY)).some((x) => x.claimId === cancelled.claimId), false);
  assert.equal(source.object.runtime.snapshot().agents.find((x) => x.id === agent.id).task?.source, "external");
});

test("legacy singleton travel is imported once without losing its reservation", async () => {
  const { source, scouts, link } = await expeditionFixture();
  const state = source.object.runtime.snapshot();
  state.tick = 25;
  const agent = state.agents.find((x) => x.id === scouts[0].id);
  const legacy = {
    agentId: agent.id, resource: "wood", direction: link.direction,
    neighborRegionId: "garden-2", boundaryTarget: link.sourcePosition,
    issuedAtTick: 24, startedAtTick: 24, claimId: "legacy-trip", claimedSupply: 2,
  };
  agent.task = { source: "autonomy", issuedAtTick: 24, type: "move", target: link.sourcePosition };
  source.object.runtime = new WorldRuntime({ state });
  await source.object.persist();
  await source.state.storage.put(TRAVEL_KEY, legacy);
  await source.state.storage.put(CLAIMS_KEY, [{
    claimId: legacy.claimId, agentId: agent.id, resource: "wood", direction: link.direction,
    neighborRegionId: "garden-2", amount: 2, expiresAtTick: 84,
  }]);
  await source.object.alarm();
  assert.deepEqual(await source.state.storage.get(TRAVELS_KEY), [legacy]);
  assert.equal(await source.state.storage.get(TRAVEL_KEY), null);
  assert.equal((await source.state.storage.get(CLAIMS_KEY))[0].claimId, legacy.claimId);
  // Simulate a crash after the v2 write but before clearing v1: never import twice.
  await source.state.storage.put(TRAVEL_KEY, legacy);
  await source.object.alarm();
  assert.equal((await source.state.storage.get(TRAVELS_KEY)).length, 1);
});

test("all expeditions survive rehydration without duplicate reservations", async () => {
  const { env, source } = await expeditionFixture();
  await source.object.alarm();
  const trips = await source.state.storage.get(TRAVELS_KEY);
  assert.equal(trips?.length, 3);
  source.object = new RegionDurableObject(source.state, env);
  await source.state.ready;
  await source.object.alarm();
  assert.deepEqual(await source.state.storage.get(TRAVELS_KEY), trips);
  assert.equal((await source.state.storage.get(CLAIMS_KEY)).length, 3);
  assert.equal(source.object.runtime.snapshot().tick, 26);
});

test("simultaneous arrivals keep ownership handoffs serial without losing waiting BOTs", async () => {
  const { source, east } = await expeditionFixture();
  await source.object.alarm();
  const trips = await source.state.storage.get(TRAVELS_KEY);
  assert.equal(trips?.length, 3);
  const state = source.object.runtime.snapshot();
  const totalAgents = state.agents.length + east.object.runtime.snapshot().agents.length;
  for (const trip of trips) state.agents.find((x) => x.id === trip.agentId).position = { ...trip.boundaryTarget };
  source.object.runtime = new WorldRuntime({ state });
  const beforeCount = state.agents.length;
  await source.object.alarm();
  const after = source.object.runtime.snapshot();
  assert.equal(after.agents.length, beforeCount - 1, "exactly one ownership transfer per tick");
  assert.equal(after.agents.length + east.object.runtime.snapshot().agents.length, totalAgents);
  assert.equal(trips.filter((trip) => after.agents.some((x) => x.id === trip.agentId)).length, 2);
});
