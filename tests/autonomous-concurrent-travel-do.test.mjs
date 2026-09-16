import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import { HEX_GRID_DIRECTION_STEPS, hexGridBoundaryCells, hexGridCenter, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { buildConfiguredHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { regionCellTransition } from "../dist-ts/src/region-topology.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";

const CLAIMS_KEY = "handoff:autonomy:claims:v1";
const HANDOFF_KEY = "handoff:autonomy:v1";
const TRAVEL_KEY = "handoff:autonomy:travel:v1";
const ARRIVAL_CLAIMS_KEY = "handoff:autonomy:arrival-claims:v1";
const DESTINATION_STORAGE_RESERVATIONS_KEY = "handoff:autonomy:destination-storage:v1";

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.alarm = null;
    this.transactionTail = Promise.resolve();
  }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async transaction(callback) {
    const previous = this.transactionTail;
    let release;
    this.transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback(this);
    } finally {
      release();
    }
  }
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
    const result = this.ready.then(callback);
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

test("resource expeditions remember when their source has storage for the return trip", async () => {
  const { source } = await expeditionFixture(2);
  const state = source.object.runtime.snapshot();
  const scout = state.agents.find((agent) => agent.autonomy);
  assert.ok(scout);
  state.structures.push({
    id: "return-home-storehouse",
    factionId: scout.factionId,
    type: "storehouse",
    position: hexGridCenter(state),
    status: "active",
    progress: 1,
    requiredProgress: 1,
    storage: { wood: 0, stone: 0, food: 0 },
  });
  source.object.runtime = new WorldRuntime({ state });
  await source.object.persist();

  await source.object.alarm();
  const claims = await source.state.storage.get(CLAIMS_KEY);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].returnToSourceStorage, true);
});

test("concurrent return expeditions reserve source storage headroom instead of overbooking it", async () => {
  const { source } = await expeditionFixture(8);
  const state = source.object.runtime.snapshot();
  const scout = state.agents.find((agent) => agent.autonomy);
  assert.ok(scout);

  for (const structure of state.structures) {
    if (structure.factionId !== scout.factionId || structure.status !== "active") continue;
    structure.storage = {
      wood: BUILD_RECIPES[structure.type].storageCapacity,
      stone: 0,
      food: 0,
    };
  }
  state.structures.push({
    id: "three-slot-return-storehouse",
    factionId: scout.factionId,
    type: "storehouse",
    position: hexGridCenter(state),
    status: "active",
    progress: 1,
    requiredProgress: 1,
    storage: { wood: BUILD_RECIPES.storehouse.storageCapacity - 3, stone: 0, food: 0 },
  });
  source.object.runtime = new WorldRuntime({ state });
  await source.object.persist();

  await source.object.alarm();
  const claims = await source.state.storage.get(CLAIMS_KEY);
  assert.equal(claims.length, 3);
  const returnClaims = claims.filter((claim) => claim.returnToSourceStorage === true);
  assert.equal(returnClaims.reduce((sum, claim) => sum + claim.amount, 0), 3);
  assert.deepEqual(returnClaims.map((claim) => claim.amount).sort((a, b) => a - b), [1, 2]);
  assert.equal(claims.filter((claim) => claim.returnToSourceStorage !== true).length, 1);
  assert.ok(claims.every((claim) => claim.sourceFactionId === scout.factionId));
});


test("concurrent scouts reserve observed destination storage headroom before launching", async () => {
  const { source, east } = await expeditionFixture(8);
  const sourceState = source.object.runtime.snapshot();
  const scout = sourceState.agents.find((agent) => agent.autonomy);
  assert.ok(scout);

  for (const structure of sourceState.structures) {
    if (structure.factionId !== scout.factionId || structure.status !== "active") continue;
    structure.storage = {
      wood: BUILD_RECIPES[structure.type].storageCapacity,
      stone: 0,
      food: 0,
    };
  }
  source.object.runtime = new WorldRuntime({ state: sourceState });
  await source.object.persist();

  const eastState = east.object.runtime.snapshot();
  for (const structure of eastState.structures) {
    if (structure.factionId !== scout.factionId || structure.status !== "active") continue;
    structure.storage = {
      wood: BUILD_RECIPES[structure.type].storageCapacity,
      stone: 0,
      food: 0,
    };
  }
  eastState.structures.push({
    id: "three-slot-expedition-storehouse",
    factionId: scout.factionId,
    type: "storehouse",
    position: hexGridCenter(eastState),
    status: "active",
    progress: 1,
    requiredProgress: 1,
    storage: { wood: BUILD_RECIPES.storehouse.storageCapacity - 3, stone: 0, food: 0 },
  });
  east.object.runtime = new WorldRuntime({ state: eastState });
  await east.object.persist();

  await source.object.alarm();
  const travels = await source.state.storage.get(TRAVELS_KEY);
  const claims = await source.state.storage.get(CLAIMS_KEY);
  assert.equal(travels.length, 2);
  assert.equal(claims.length, 2);
  assert.equal(claims.reduce((sum, claim) => sum + claim.amount, 0), 3);
  assert.deepEqual(claims.map((claim) => claim.amount).sort((a, b) => a - b), [1, 2]);
  assert.ok(claims.every((claim) => claim.returnToSourceStorage !== true));
  assert.ok(claims.every((claim) => claim.destinationStorageReserved === true));
  assert.ok(claims.every((claim) => claim.sourceFactionId === scout.factionId));
  const remoteReservations = await east.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY);
  assert.equal(remoteReservations.length, 2);
  assert.equal(remoteReservations.reduce((sum, entry) => sum + entry.amount, 0), 3);
  assert.ok(remoteReservations.every((entry) => entry.sourceRegionId === "garden-1"));

  const nearExpiry = Date.now() + 1_000;
  for (const reservation of remoteReservations) reservation.expiresAtMs = nearExpiry;
  await east.state.storage.put(DESTINATION_STORAGE_RESERVATIONS_KEY, remoteReservations);

  await source.object.alarm();
  const renewedReservations = await east.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY);
  assert.equal(renewedReservations.length, 2);
  assert.ok(
    renewedReservations.every((entry) => entry.expiresAtMs > nearExpiry),
    "source-side in-flight travel must renew admitted remote storage before arrival",
  );
});


test("destination storage admission is shared across source regions and releases idempotently", async () => {
  const env = environment();
  const destination = await assignRegion(env, "garden-2");
  const state = destination.object.runtime.snapshot();
  const factionId = state.agents[0]?.factionId;
  assert.ok(factionId);

  for (const structure of state.structures) {
    if (structure.factionId !== factionId || structure.status !== "active") continue;
    structure.storage = {
      wood: BUILD_RECIPES[structure.type].storageCapacity,
      stone: 0,
      food: 0,
    };
  }
  state.structures.push({
    id: "three-slot-shared-destination-storehouse",
    factionId,
    type: "storehouse",
    position: hexGridCenter(state),
    status: "active",
    progress: 1,
    requiredProgress: 1,
    storage: { wood: BUILD_RECIPES.storehouse.storageCapacity - 3, stone: 0, food: 0 },
  });
  destination.object.runtime = new WorldRuntime({ state });
  await destination.object.persist();

  const reserve = async (claimId, sourceRegionId, amount) => {
    const response = await destination.object.fetch(new Request(
      "https://moyo.internal/api/internal/autonomy/storage/reserve",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-moyo-region-internal": "garden-2",
        },
        body: JSON.stringify({ claimId, sourceRegionId, factionId, amount }),
      },
    ));
    assert.equal(response.status, 200);
    return response.json();
  };

  const [sourceA, sourceB] = await Promise.all([
    reserve("source-a", "garden-1", 2),
    reserve("source-b", "garden-3", 2),
  ]);
  assert.deepEqual(
    [sourceA.grantedAmount, sourceB.grantedAmount].sort((left, right) => left - right),
    [1, 2],
    "concurrent source regions must share one atomic three-slot budget",
  );
  assert.equal((await reserve("source-c", "garden-1", 1)).grantedAmount, 0);
  assert.equal(
    (await reserve("source-a", "garden-1", 2)).grantedAmount,
    sourceA.grantedAmount,
    "retry must be idempotent",
  );

  const edgeResponse = await destination.object.fetch(new Request(
    "https://moyo.internal/api/internal/halo/edge?direction=west",
    {
      method: "GET",
      headers: { "x-moyo-region-internal": "garden-2" },
    },
  ));
  assert.equal(edgeResponse.status, 200);
  const edge = await edgeResponse.json();
  assert.equal(
    edge.regionSummary.storageHeadroomByFaction[factionId],
    0,
    "halo summary must advertise headroom after active destination reservations",
  );

  const release = await destination.object.fetch(new Request(
    "https://moyo.internal/api/internal/autonomy/storage/release",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-moyo-region-internal": "garden-2",
      },
      body: JSON.stringify({ claimId: "source-a", sourceRegionId: "garden-1" }),
    },
  ));
  assert.equal(release.status, 200);
  assert.equal(
    (await reserve("source-d", "garden-1", 2)).grantedAmount,
    sourceA.grantedAmount,
    "releasing one source must restore exactly its admitted capacity",
  );
  const reservations = await destination.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY);
  assert.equal(reservations.reduce((sum, entry) => sum + entry.amount, 0), 3);
});

test("remote sink reservation remains until gathered cargo leaves the arriving inventory", async () => {
  const env = environment();
  await assignRegion(env, "garden-1");
  const destination = await assignRegion(env, "garden-2");
  let state = destination.object.runtime.snapshot();
  const agent = state.agents[0];
  assert.ok(agent);
  agent.autonomy = true;
  agent.role = "woodcutter";
  agent.capacity = 10;
  agent.energy = 100;
  agent.inventory = { wood: 0, stone: 0, food: 0 };
  agent.task = { source: "autonomy", issuedAtTick: state.tick, type: "gather", resource: "wood" };
  const factionId = agent.factionId;
  for (const structure of state.structures) {
    if (structure.factionId !== factionId || structure.status !== "active") continue;
    structure.storage = { wood: BUILD_RECIPES[structure.type].storageCapacity, stone: 0, food: 0 };
  }
  state.structures.push({
    id: "reserved-arrival-storehouse", factionId, type: "storehouse",
    position: hexGridCenter(state), status: "active", progress: 1, requiredProgress: 1,
    storage: { wood: BUILD_RECIPES.storehouse.storageCapacity - 2, stone: 0, food: 0 },
  });
  destination.object.runtime = new WorldRuntime({ state });
  await destination.object.persist();

  const reservationResponse = await destination.object.fetch(new Request(
    "https://moyo.internal/api/internal/autonomy/storage/reserve", {
      method: "POST",
      headers: { "content-type": "application/json", "x-moyo-region-internal": "garden-2" },
      body: JSON.stringify({ claimId: "remote-sink-cargo", sourceRegionId: "garden-1", factionId, amount: 2 }),
    },
  ));
  assert.equal(reservationResponse.status, 200);
  assert.equal((await reservationResponse.json()).grantedAmount, 2);

  const arrivalResponse = await destination.object.fetch(new Request(
    "https://moyo.internal/api/internal/autonomy/claim/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-moyo-region-internal": "garden-2" },
      body: JSON.stringify({ claimId: "remote-sink-cargo", sourceRegionId: "garden-1", agentId: agent.id, resource: "wood" }),
    },
  ));
  assert.equal(arrivalResponse.status, 200);
  const registered = await destination.state.storage.get(ARRIVAL_CLAIMS_KEY);
  assert.equal(registered[0].destinationStorageReserved, true);
  registered[0].gatheredAmount = 2;
  registered[0].settledAmount = 2;
  await destination.state.storage.put(ARRIVAL_CLAIMS_KEY, registered);

  state = destination.object.runtime.snapshot();
  const carrying = state.agents.find((entry) => entry.id === agent.id);
  assert.ok(carrying);
  carrying.autonomy = false;
  carrying.inventory.wood = 2;
  delete carrying.task;

  destination.object.runtime = new WorldRuntime({ state });
  await destination.object.persist();
  const expiredAt = Date.now() - 1;
  const expiringReservations = await destination.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY);
  assert.equal(expiringReservations.length, 1);
  expiringReservations[0].expiresAtMs = expiredAt;
  await destination.state.storage.put(DESTINATION_STORAGE_RESERVATIONS_KEY, expiringReservations);

  const protectedEdgeResponse = await destination.object.fetch(new Request(
    "https://moyo.internal/api/internal/halo/edge?direction=west",
    {
      method: "GET",
      headers: { "x-moyo-region-internal": "garden-2" },
    },
  ));
  assert.equal(protectedEdgeResponse.status, 200);
  const protectedEdge = await protectedEdgeResponse.json();
  const protectedReservations = await destination.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY);
  assert.equal(protectedReservations.length, 1);
  assert.ok(protectedReservations[0].expiresAtMs > expiredAt);
  assert.equal(
    protectedEdge.regionSummary.storageHeadroomByFaction[factionId],
    0,
    "expired lease must stay reserved while admitted cargo is still on the BOT",
  );
  for (const structure of state.structures) {
    if (structure.factionId !== factionId || structure.status !== "active") continue;
    structure.storage = { wood: BUILD_RECIPES[structure.type].storageCapacity, stone: 0, food: 0 };
  }
  destination.object.runtime = new WorldRuntime({ state });
  await destination.object.persist();

  await destination.object.alarm();
  assert.equal((await destination.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY)).length, 1);
  assert.equal((await destination.state.storage.get(ARRIVAL_CLAIMS_KEY)).length, 1);

  state = destination.object.runtime.snapshot();
  const delivered = state.agents.find((entry) => entry.id === agent.id);
  assert.ok(delivered);
  delivered.inventory.wood = 0;
  destination.object.runtime = new WorldRuntime({ state });
  await destination.object.persist();

  await destination.object.alarm();
  assert.deepEqual(await destination.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY), []);
  assert.deepEqual(await destination.state.storage.get(ARRIVAL_CLAIMS_KEY), []);
});
