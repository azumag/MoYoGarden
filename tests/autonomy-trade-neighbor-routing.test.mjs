import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";

class MemoryStorage {
  constructor() { this.values = new Map(); this.alarm = null; this.transactionTail = Promise.resolve(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async transaction(callback) {
    const previous = this.transactionTail;
    let release;
    this.transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await callback(this); } finally { release(); }
  }
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
    if (!entry) {
      const state = new MemoryState();
      const object = new RegionDurableObject(state, this.env);
      entry = { state, object };
      this.entries.set(id, entry);
    }
    return { fetch: async (request) => { await entry.state.ready; return entry.object.fetch(request); } };
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
async function assignRegion(env, regionId) {
  await worker.fetch(new Request(`https://moyo.example/api/world/snapshot?region=${regionId}`), env);
  const entry = env.REGIONS.entries.get(regionId);
  assert.ok(entry);
  await entry.state.ready;
  return entry;
}
function makeActiveHexPassable(state) {
  for (const tile of state.tiles) if (isHexGridCell(state, tile)) tile.terrain = "plain";
}

test("autonomous trade discovers an immediate neighboring owner and completes after handoff", async () => {
  const env = environment();
  const source = await assignRegion(env, "garden-1");
  const target = await assignRegion(env, "garden-2");
  const sourceState = source.object.runtime.snapshot();
  const targetState = target.object.runtime.snapshot();
  makeActiveHexPassable(sourceState);
  makeActiveHexPassable(targetState);
  for (const candidate of sourceState.agents) candidate.autonomy = false;
  for (const candidate of targetState.agents) candidate.autonomy = false;

  const trader = sourceState.agents[0];
  const counterparty = targetState.agents[0];
  assert.ok(trader);
  assert.ok(counterparty);
  trader.autonomy = true;
  trader.energy = 100;
  trader.capacity = 12;
  trader.inventory = { wood: 3, stone: 0, food: 0 };
  counterparty.id = `agent-global:garden-2:${counterparty.id}`;
  counterparty.factionId = trader.factionId;
  counterparty.inventory = { wood: 0, stone: 3, food: 0 };
  trader.task = {
    source: "autonomy",
    issuedAtTick: sourceState.tick,
    type: "trade",
    targetAgentId: counterparty.id,
    offer: { wood: 1, stone: 0, food: 0 },
    request: { wood: 0, stone: 1, food: 0 },
  };
  source.object.runtime = new WorldRuntime({ state: sourceState });
  target.object.runtime = new WorldRuntime({ state: targetState });
  await source.object.persist();
  await target.object.persist();

  let completed = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await source.object.alarm();
    await target.object.alarm();
    const currentTarget = target.object.runtime.snapshot();
    const arrived = currentTarget.agents.find((entry) => entry.id === `agent-global:garden-1:${trader.id}`);
    const remote = currentTarget.agents.find((entry) => entry.id === counterparty.id);
    if (arrived?.inventory.stone === 1 && remote?.inventory.wood === 1) {
      completed = true;
      break;
    }
  }
  assert.equal(completed, true, "one-hop discovery should lead to an atomic trade in the owning region");
  assert.equal(
    source.object.runtime.snapshot().agents.some((entry) => entry.id === trader.id),
    false,
    "source ownership must detach after the cross-region trade handoff",
  );
});
