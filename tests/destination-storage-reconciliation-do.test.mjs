import assert from "node:assert/strict";
import test from "node:test";
import { RegionDurableObject } from "../dist-ts/src/arrival-registration-reliability-entry.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { hexGridCenter } from "../dist-ts/src/hex-grid.js";

const CAPACITY = "handoff:autonomy:destination-storage:v1";
const FENCES = "handoff:autonomy:destination-storage-generation:v1";
class MemoryStorage {
  values = new Map();
  alarm = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async transaction(callback) { return callback(this); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value instanceof Date ? value.getTime() : value; }
  async deleteAlarm() { this.alarm = null; }
}
class MemoryState {
  storage = new MemoryStorage();
  ready = Promise.resolve();
  blockConcurrencyWhile(callback) {
    const result = this.ready.then(callback);
    this.ready = result.catch(() => {});
    return result;
  }
  acceptWebSocket() {}
  getWebSockets() { return []; }
}
const env = {
  WORLD_SEED: "737373", REGION_IDS: "garden-2", TICK_MS: "10000",
  OPEN_COMMANDS: "false", ASSETS: { fetch: async () => new Response("", { status: 404 }) },
  REGIONS: { idFromName(name) { return name; }, get() { throw new Error("passive read fetched neighbor"); } },
};
const request = (path) => new Request(`https://moyo.internal${path}`, {
  headers: { "x-moyo-region-internal": "garden-2" },
});
async function fixture(latestReserveIssuedAtMs) {
  const ctx = new MemoryState();
  const object = new RegionDurableObject(ctx, env);
  await ctx.ready;
  await object.fetch(request("/api/health"));
  await object.alarm();
  assert.equal(ctx.storage.alarm, null);
  const state = object.runtime.snapshot();
  const factionId = state.agents[0].factionId;
  for (const structure of state.structures) {
    if (structure.factionId === factionId && structure.status === "active") {
      structure.storage = { wood: BUILD_RECIPES[structure.type].storageCapacity, stone: 0, food: 0 };
    }
  }
  state.structures.push({ id: "three-slots", factionId, type: "storehouse",
    position: hexGridCenter(state), status: "active", progress: 1, requiredProgress: 1,
    storage: { wood: BUILD_RECIPES.storehouse.storageCapacity - 3, stone: 0, food: 0 } });
  object.runtime = new WorldRuntime({ state });
  await object.persist();
  const expiresAtMs = Date.now() + 600_000;
  await ctx.storage.put(CAPACITY, [{ sourceRegionId: "garden-1", claimId: "claim-1", factionId, amount: 3, expiresAtMs }]);
  await ctx.storage.put(FENCES, [{ sourceRegionId: "garden-1", claimId: "claim-1", latestReserveIssuedAtMs, releaseIssuedAtMs: 300, expiresAtMs }]);
  return { values: structuredClone(ctx.storage.values), factionId };
}
async function readFresh(values, path) {
  const ctx = new MemoryState();
  ctx.storage.values = structuredClone(values);
  const object = new RegionDurableObject(ctx, env);
  await ctx.ready;
  const response = await object.fetch(request(path));
  assert.equal(response.status, 200);
  const payload = await response.json();
  const health = await (await object.fetch(request("/api/health"))).json();
  assert.equal(health.tickMode, "cold");
  assert.equal(health.deepIdle, true);
  assert.equal(ctx.storage.alarm, null);
  return { payload, rows: await ctx.storage.get(CAPACITY) };
}
for (const [name, generation, expectedHeadroom, expectedRows] of [
  ["release crash residue", 200, 3, 0],
  ["newer reserve generation", 400, 0, 1],
]) {
  test(`production single/batch passive reads reconcile ${name} identically`, async () => {
    const { values, factionId } = await fixture(generation);
    const single = await readFresh(values, "/api/internal/halo/edge?direction=west");
    const batch = await readFresh(values, "/api/internal/halo/edges?directions=west,east");
    assert.equal(single.rows.length, expectedRows);
    assert.deepEqual(batch.rows, single.rows);
    assert.equal(single.payload.regionSummary.storageHeadroomByFaction[factionId], expectedHeadroom);
    for (const edge of batch.payload.edges) {
      assert.equal(edge.regionSummary.storageHeadroomByFaction[factionId], expectedHeadroom);
      assert.equal(edge.tick, single.payload.tick);
      assert.equal(edge.revision, single.payload.revision);
      assert.deepEqual(edge.regionSummary.storageComponentsByFaction, single.payload.regionSummary.storageComponentsByFaction);
    }
  });
}
