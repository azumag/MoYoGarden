import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import {
  autonomyHaloLinksForTier,
  isAutonomyClaimSourceRegionId,
} from "../dist-ts/src/autonomy-region.js";
import { buildConfiguredHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { hexGridCenter, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";

const CLAIMS_KEY = "handoff:autonomy:claims:v1";
const TRAVEL_KEY = "handoff:autonomy:travel:v2";

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

/**
 * Region Durable Objects receive a copied env (arrival-registration and
 * generation-stamped wrappers), so a getter installed on the Worker env alone
 * would not be observed inside the object. Install the failing getter on every
 * env copy the objects hold, so any configured-list read in the autonomy hot
 * path fails loudly instead of silently succeeding.
 */
function forbidRegionListReads(env, counter) {
  const patched = new Set();
  const patch = (candidate) => {
    if (candidate === null || typeof candidate !== "object" || patched.has(candidate)) return;
    patched.add(candidate);
    if (Object.getOwnPropertyDescriptor(candidate, "REGION_IDS") === undefined) return;
    Object.defineProperty(candidate, "REGION_IDS", {
      configurable: true,
      get() {
        counter.reads += 1;
        throw new Error("autonomy hot path must not read REGION_IDS");
      },
    });
  };
  patch(env);
  for (const entry of env.REGIONS.entries.values()) {
    for (const value of Object.values(entry.object)) patch(value);
  }
  return patched.size;
}

async function assignRegion(env, regionId) {
  const response = await worker.fetch(
    new Request(`https://moyo.example/api/world/snapshot?region=${regionId}`),
    env,
  );
  assert.equal(response.status, 200);
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

test("active autonomy halo routing resolves six neighbors without reading REGION_IDS", () => {
  let reads = 0;
  const links = autonomyHaloLinksForTier(
    { width: 40, height: 24 },
    "garden-1",
    "active",
    () => {
      reads += 1;
      throw new Error("active autonomy halo must not read REGION_IDS");
    },
  );
  assert.equal(reads, 0);
  assert.equal(links.length, 138);
  assert.equal(new Set(links.map((link) => link.neighborRegionId)).size, 6);
  assert.equal(links.every((link) => link.sourceRegionId === "garden-1"), true);
});

test("warm/cold autonomy halo keeps the configured-only compatibility set", () => {
  let reads = 0;
  const links = autonomyHaloLinksForTier(
    { width: 40, height: 24 },
    "garden-1",
    "warm",
    () => {
      reads += 1;
      return ["garden-1", "garden-2", "garden-3"];
    },
  );
  assert.equal(reads, 1);
  assert.equal(links.length, 46);
  assert.deepEqual(
    new Set(links.map((link) => link.neighborRegionId)),
    new Set(["garden-2", "garden-3"]),
  );
});

test("autonomy claim sources with an axial identity skip the configured allow-list", () => {
  const exploding = () => {
    throw new Error("axial claim source must not read REGION_IDS");
  };
  assert.equal(isAutonomyClaimSourceRegionId(exploding, "hex-q2-r-1"), true);
  assert.equal(isAutonomyClaimSourceRegionId(exploding, "garden-1"), true);

  let reads = 0;
  assert.equal(
    isAutonomyClaimSourceRegionId(() => {
      reads += 1;
      return ["garden-1"];
    }, "historical-unknown"),
    false,
  );
  assert.equal(reads, 1, "unresolved historical ids still consult the compatibility allow-list");
});

test("active legacy supply scouting does not read REGION_IDS after assignment", async () => {
  const env = environment();
  const source = await assignRegion(env, "garden-1");
  const east = await assignRegion(env, "garden-2");
  const northEast = await assignRegion(env, "garden-3");
  const otherDynamicNeighbors = await Promise.all([
    "hex-q-1-r0",
    "hex-q-1-r1",
    "hex-q0-r-1",
    "hex-q0-r1",
  ].map((regionId) => assignRegion(env, regionId)));
  for (const entry of otherDynamicNeighbors) {
    const state = entry.object.runtime.snapshot();
    depleteWood(state);
    entry.object.runtime = new WorldRuntime({ state });
    await entry.object.persist();
  }

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
  placeLinkedBoundaryWood(sourceState, eastState, "east", "garden-2", 12);
  east.object.runtime = new WorldRuntime({ state: eastState });
  await east.object.persist();

  const northEastState = northEast.object.runtime.snapshot();
  depleteWood(northEastState);
  placeLinkedBoundaryWood(sourceState, northEastState, "northEast", "garden-3", 4);
  northEast.object.runtime = new WorldRuntime({ state: northEastState });
  await northEast.object.persist();

  await source.state.storage.put(CLAIMS_KEY, [{
    claimId: "prior-east-expedition",
    resource: "wood",
    direction: "east",
    neighborRegionId: "garden-2",
    amount: 12,
    expiresAtTick: 84,
  }]);

  const counter = { reads: 0 };
  const patched = forbidRegionListReads(env, counter);
  assert.ok(patched > 1, "the failing getter must be installed on the object env copies");

  await source.object.alarm();

  assert.equal(counter.reads, 0, "active legacy supply scouting must not read REGION_IDS");

  const travels = await source.state.storage.get(TRAVEL_KEY);
  assert.ok(Array.isArray(travels));
  assert.equal(travels.length, 1);
  assert.equal(travels[0].neighborRegionId, "garden-3");
});
