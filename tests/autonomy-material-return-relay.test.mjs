import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import { hexGridCenter, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { materialReturnHopDistance } from "../dist-ts/src/autonomy-region.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";

const ARRIVAL_CLAIMS_KEY = "handoff:autonomy:arrival-claims:v1";
const SUPPLY_CLAIMS_KEY = "handoff:autonomy:claims:v1";
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
  blockConcurrencyWhile(callback) { const result = this.ready.then(callback); this.ready = result.catch(() => {}); return result; }
  acceptWebSocket(socket) { this.sockets.push(socket); }
  getWebSockets() { return [...this.sockets]; }
}
class MemoryNamespace {
  constructor(env) { this.env = env; this.entries = new Map(); }
  idFromName(name) { return name; }
  get(id) {
    let entry = this.entries.get(id);
    if (!entry) { const state = new MemoryState(); const object = new RegionDurableObject(state, this.env); entry = { state, object }; this.entries.set(id, entry); }
    return { fetch: async (request) => { await entry.state.ready; return entry.object.fetch(request); } };
  }
}
function environment() {
  const env = { WORLD_SEED: "919191", REGION_IDS: "garden-1,garden-2,garden-3", TICK_MS: "10000", OPEN_COMMANDS: "false", COMMAND_TOKEN: "command-secret", ADMIN_TOKEN: "admin-secret", ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } };
  env.REGIONS = new MemoryNamespace(env); return env;
}
async function assignRegion(env, regionId) {
  await worker.fetch(new Request(`https://moyo.example/api/world/snapshot?region=${regionId}`), env);
  const entry = env.REGIONS.entries.get(regionId); assert.ok(entry); await entry.state.ready; return entry;
}
function makeActiveHexPassable(state) {
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
  }
}

test("material return routing only accepts macro hops that strictly approach the claim origin", () => {
  assert.equal(materialReturnHopDistance("hex-q0-r0", "hex-q2-r0", "garden-2"), 1);
  assert.equal(materialReturnHopDistance("garden-2", "hex-q2-r0", "hex-q2-r0"), 0);
  assert.equal(materialReturnHopDistance("hex-q0-r0", "hex-q2-r0", "hex-q-1-r0"), undefined);
});

test("gathered cargo can relay through a storage-less intermediate region without losing its origin claim", async () => {
  const env = environment();
  const first = await assignRegion(env, "hex-q0-r0");
  const relay = await assignRegion(env, "garden-2");
  const origin = await assignRegion(env, "hex-q2-r0");
  const firstState = first.object.runtime.snapshot();
  firstState.tick = 24; firstState.structures = [];
  for (const candidate of firstState.agents) candidate.autonomy = false;
  const courier = firstState.agents[0]; assert.ok(courier);
  courier.autonomy = true; courier.position = hexGridCenter(firstState); courier.energy = 100; courier.capacity = 8;
  courier.inventory = { wood: 4, stone: 0, food: 0 }; courier.task = { source: "autonomy", issuedAtTick: 24, type: "deposit" };
  first.object.runtime = new WorldRuntime({ state: firstState }); await first.object.persist();
  const relayState = relay.object.runtime.snapshot(); relayState.structures = []; makeActiveHexPassable(relayState);
  for (const candidate of relayState.agents) candidate.autonomy = false;
  relay.object.runtime = new WorldRuntime({ state: relayState }); await relay.object.persist();
  const originState = origin.object.runtime.snapshot(); makeActiveHexPassable(originState);
  for (const candidate of originState.agents) candidate.autonomy = false;
  originState.structures = [{ id: "origin-storehouse", factionId: courier.factionId, type: "storehouse", position: hexGridCenter(originState), status: "active", progress: 1, requiredProgress: 1, storage: { wood: 0, stone: 0, food: 0 } }];
  origin.object.runtime = new WorldRuntime({ state: originState }); await origin.object.persist();
  await origin.state.storage.put(SUPPLY_CLAIMS_KEY, [{ claimId: "two-hop-return", agentId: courier.id, resource: "wood", direction: "W", neighborRegionId: "garden-2", amount: 0, settledAmount: 4, expiresAtTick: originState.tick + 1000, sourceFactionId: courier.factionId, returnToSourceStorage: true, returnStorageAmount: 4 }]);
  const reservedBeforeReturn = await origin.state.storage.get(SUPPLY_CLAIMS_KEY);
  const returnReservation = reservedBeforeReturn?.find((entry) => entry.claimId === "two-hop-return");
  assert.equal(returnReservation?.amount, 0, "gathered supply may be fully settled while sink capacity remains reserved");
  assert.equal(returnReservation?.returnStorageAmount, 4, "source storage reservation must be independent of remaining remote supply");
  await first.state.storage.put(ARRIVAL_CLAIMS_KEY, [{ claimId: "two-hop-return", sourceRegionId: "hex-q2-r0", agentId: courier.id, resource: "wood", registeredAtTick: 24, gatheredAmount: 4, settledAmount: 4, returnToSourceStorage: true }]);
  let deposited = false;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await first.object.alarm(); await relay.object.alarm(); await origin.object.alarm();
    const storehouse = origin.object.runtime.snapshot().structures.find((entry) => entry.id === "origin-storehouse");
    if ((storehouse?.storage.wood ?? 0) >= 4) { deposited = true; break; }
  }
  assert.equal(deposited, true, "cargo should cross both ownership handoffs and deposit at the origin storehouse");
  const sourceClaimsAfterDeposit = await origin.state.storage.get(SUPPLY_CLAIMS_KEY);
  assert.ok(sourceClaimsAfterDeposit === undefined || sourceClaimsAfterDeposit.every((entry) => entry.claimId !== "two-hop-return"), "source storage reservation must release only after the carried cargo is deposited");
  const relayClaims = await relay.state.storage.get(ARRIVAL_CLAIMS_KEY);
  assert.ok(relayClaims === undefined || relayClaims.length === 0 || relayClaims.every((entry) => entry.sourceRegionId === "hex-q2-r0"));
});

test("blocked relay keeps its ultimate return claim instead of orphaning cargo", async () => {
  const env = environment();
  const relay = await assignRegion(env, "garden-2");
  const relayState = relay.object.runtime.snapshot(); relayState.structures = [];
  for (const candidate of relayState.agents) candidate.autonomy = false;
  const courier = relayState.agents[0]; assert.ok(courier);
  courier.autonomy = true; courier.position = hexGridCenter(relayState); courier.inventory = { wood: 4, stone: 0, food: 0 };
  courier.task = { source: "autonomy", issuedAtTick: relayState.tick, type: "deposit" };
  // Make every active boundary cell water while leaving the courier's current cell passable.
  for (const tile of relayState.tiles) {
    if (!isHexGridCell(relayState, tile)) continue;
    const boundary = tile.x <= 8 || tile.x >= 30 || tile.y <= 0 || tile.y >= 22;
    if (boundary) tile.terrain = "water";
  }
  const centerTile = relayState.tiles.find((tile) => tile.x === courier.position.x && tile.y === courier.position.y);
  if (centerTile) centerTile.terrain = "plain";
  relay.object.runtime = new WorldRuntime({ state: relayState }); await relay.object.persist();
  await relay.state.storage.put(ARRIVAL_CLAIMS_KEY, [{ claimId: "blocked-return", sourceRegionId: "hex-q2-r0", agentId: courier.id, resource: "wood", registeredAtTick: relayState.tick, gatheredAmount: 4, settledAmount: 4, returnToSourceStorage: true }]);
  await relay.object.alarm();
  const claims = await relay.state.storage.get(ARRIVAL_CLAIMS_KEY);
  assert.equal(claims?.length, 1);
  assert.equal(claims?.[0]?.sourceRegionId, "hex-q2-r0");
  const afterCourier = relay.object.runtime.snapshot().agents.find((entry) => entry.id === courier.id);
  assert.equal(afterCourier?.inventory.wood, 4);
});
