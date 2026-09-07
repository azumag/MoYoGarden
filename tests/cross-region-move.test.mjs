import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import { globalHandoffAgentId } from "../dist-ts/src/agent-ownership.js";
import {
  HEX_GRID_DIRECTION_STEPS,
  hexGridBoundaryCells,
} from "../dist-ts/src/hex-grid.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";

class MemoryStorage {
  constructor() { this.values = new Map(); this.alarm = null; }
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

async function call(env, path, init = {}) {
  const response = await worker.fetch(new Request(`https://moyo.example${path}`, init), env);
  return { response, body: await response.json() };
}

function commandInit(body, authorized = true) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: "Bearer command-secret" } : {}),
    },
    body: JSON.stringify(body),
  };
}

async function placeBoundaryAgent(env, direction) {
  const initial = await call(env, "/api/world/snapshot?region=garden-1");
  assert.equal(initial.response.status, 200);
  const entry = env.REGIONS.entries.get("garden-1");
  assert.ok(entry);
  await entry.state.ready;
  const state = entry.object.runtime.snapshot();
  const agent = state.agents[0];
  assert.ok(agent);
  const cell = hexGridBoundaryCells(state, direction)[11];
  assert.ok(cell);
  const tile = state.tiles[cell.y * state.width + cell.x];
  assert.ok(tile);
  tile.terrain = "plain";
  agent.position = { ...cell };
  agent.autonomy = false;
  delete agent.task;
  entry.object.runtime = new WorldRuntime({ state });
  await entry.object.persist();
  return { agentId: agent.id, cell };
}

test("one-step move across a hex side becomes a normal command-driven region handoff", async () => {
  const env = environment();
  const { agentId, cell } = await placeBoundaryAgent(env, "east");
  const step = HEX_GRID_DIRECTION_STEPS.east;
  const target = { x: cell.x + step.x, y: cell.y + step.y };
  const body = { id: "move-cross-east-1", type: "move", target };

  const moved = await call(
    env,
    `/api/agents/${encodeURIComponent(agentId)}/commands?region=garden-1`,
    commandInit(body),
  );
  assert.equal(moved.response.status, 202);
  assert.equal(moved.body.accepted, true);
  assert.equal(moved.body.commandId, body.id);
  assert.equal(moved.body.handoff.phase, "committed");
  assert.equal(moved.body.handoff.toRegionId, "garden-2");

  const source = (await call(env, "/api/world/snapshot?region=garden-1")).body;
  const targetState = (await call(env, "/api/world/snapshot?region=garden-2")).body;
  const globalId = globalHandoffAgentId(agentId, "garden-1");
  assert.equal(source.agents.some((agent) => agent.id === agentId), false);
  assert.equal(targetState.agents.filter((agent) => agent.id === globalId).length, 1);

  const retry = await call(
    env,
    `/api/agents/${encodeURIComponent(agentId)}/commands?region=garden-1`,
    commandInit(body),
  );
  assert.equal(retry.response.status, 202);
  assert.equal(retry.body.handoff.phase, "committed");
  const afterRetry = (await call(env, "/api/world/snapshot?region=garden-2")).body;
  assert.equal(afterRetry.agents.filter((agent) => agent.id === globalId).length, 1);
});

test("command-driven crossing follows the exact global cell owner at a slanted seam", async () => {
  const env = environment();
  const initial = await call(env, "/api/world/snapshot?region=garden-1");
  assert.equal(initial.response.status, 200);
  const sourceEntry = env.REGIONS.entries.get("garden-1");
  assert.ok(sourceEntry);
  await sourceEntry.state.ready;
  const state = sourceEntry.object.runtime.snapshot();
  const agent = state.agents[0];
  assert.ok(agent);
  const cell = hexGridBoundaryCells(state, "northEast")
    .find((position) => position.x === 30 && position.y === 1);
  assert.deepEqual(cell, { x: 30, y: 1 });
  const sourceTile = state.tiles[cell.y * state.width + cell.x];
  assert.ok(sourceTile);
  sourceTile.terrain = "plain";
  delete sourceTile.resource;
  agent.position = { ...cell };
  agent.autonomy = false;
  delete agent.task;
  sourceEntry.object.runtime = new WorldRuntime({ state });
  await sourceEntry.object.persist();

  const targetEntryInit = await call(env, "/api/world/snapshot?region=garden-2");
  assert.equal(targetEntryInit.response.status, 200);
  const targetEntry = env.REGIONS.entries.get("garden-2");
  assert.ok(targetEntry);
  await targetEntry.state.ready;
  const targetState = targetEntry.object.runtime.snapshot();
  const exactEntry = { x: 8, y: 11 };
  const targetTile = targetState.tiles[exactEntry.y * targetState.width + exactEntry.x];
  assert.ok(targetTile);
  targetTile.terrain = "plain";
  delete targetTile.resource;
  targetEntry.object.runtime = new WorldRuntime({ state: targetState });
  await targetEntry.object.persist();

  const step = HEX_GRID_DIRECTION_STEPS.northEast;
  const desired = { x: cell.x + step.x, y: cell.y + step.y };
  assert.deepEqual(desired, { x: 31, y: 0 });
  const moved = await call(
    env,
    `/api/agents/${encodeURIComponent(agent.id)}/commands?region=garden-1`,
    commandInit({ id: "move-slanted-owner", type: "move", target: desired }),
  );

  assert.equal(moved.response.status, 202);
  assert.equal(moved.body.handoff.toRegionId, "garden-2");
  const arrived = (await call(env, "/api/world/snapshot?region=garden-2")).body.agents
    .find((entry) => entry.id === globalHandoffAgentId(agent.id, "garden-1"));
  assert.ok(arrived);
  assert.deepEqual(arrived.position, exactEntry);
  assert.equal(env.REGIONS.entries.has("garden-3"), false);
});

test("command-driven crossing fails closed when the exact global owner is not configured", async () => {
  const env = environment();
  const initial = await call(env, "/api/world/snapshot?region=garden-1");
  assert.equal(initial.response.status, 200);
  const entry = env.REGIONS.entries.get("garden-1");
  assert.ok(entry);
  await entry.state.ready;
  const state = entry.object.runtime.snapshot();
  const agent = state.agents[0];
  assert.ok(agent);
  const cell = hexGridBoundaryCells(state, "east")
    .find((position) => position.x === 29 && position.y === 12);
  assert.deepEqual(cell, { x: 29, y: 12 });
  const tile = state.tiles[cell.y * state.width + cell.x];
  assert.ok(tile);
  tile.terrain = "plain";
  delete tile.resource;
  agent.position = { ...cell };
  agent.autonomy = false;
  delete agent.task;
  entry.object.runtime = new WorldRuntime({ state });
  await entry.object.persist();

  const step = HEX_GRID_DIRECTION_STEPS.east;
  const result = await call(
    env,
    `/api/agents/${encodeURIComponent(agent.id)}/commands?region=garden-1`,
    commandInit({
      id: "move-unconfigured-owner",
      type: "move",
      target: { x: cell.x + step.x, y: cell.y + step.y },
    }),
  );

  assert.equal(result.response.status, 409);
  assert.match(result.body.error, /exact adjacent cell owner is not configured/);
  const source = (await call(env, "/api/world/snapshot?region=garden-1")).body;
  assert.equal(source.agents.some((candidate) => candidate.id === agent.id), true);
  assert.equal(env.REGIONS.entries.has("garden-2"), false);
});

test("cross-region move requires a stable explicit command id", async () => {
  const env = environment();
  const { agentId, cell } = await placeBoundaryAgent(env, "northEast");
  const step = HEX_GRID_DIRECTION_STEPS.northEast;
  const target = { x: cell.x + step.x, y: cell.y + step.y };
  const result = await call(
    env,
    `/api/agents/${encodeURIComponent(agentId)}/commands?region=garden-1`,
    commandInit({ type: "move", target }),
  );
  assert.equal(result.response.status, 400);
  assert.match(result.body.reason, /stable command id/);
  const source = (await call(env, "/api/world/snapshot?region=garden-1")).body;
  assert.equal(source.agents.some((agent) => agent.id === agentId), true);
});

test("cross-region move keeps command-token authentication", async () => {
  const env = environment();
  const { agentId, cell } = await placeBoundaryAgent(env, "east");
  const step = HEX_GRID_DIRECTION_STEPS.east;
  const result = await call(
    env,
    `/api/agents/${encodeURIComponent(agentId)}/commands?region=garden-1`,
    commandInit({
      id: "unauthorized-crossing",
      type: "move",
      target: { x: cell.x + step.x, y: cell.y + step.y },
    }, false),
  );
  assert.equal(result.response.status, 401);
  const source = (await call(env, "/api/world/snapshot?region=garden-1")).body;
  assert.equal(source.agents.some((agent) => agent.id === agentId), true);
});

test("ordinary in-region move still delegates to the existing command queue", async () => {
  const env = environment();
  const initial = await call(env, "/api/world/snapshot?region=garden-1");
  const agent = initial.body.agents[0];
  assert.ok(agent);
  const target = { x: agent.position.x + 1, y: agent.position.y };
  const entry = env.REGIONS.entries.get("garden-1");
  const state = entry.object.runtime.snapshot();
  const tile = state.tiles[target.y * state.width + target.x];
  assert.ok(tile);
  tile.terrain = "plain";
  entry.object.runtime = new WorldRuntime({ state });
  await entry.object.persist();

  const result = await call(
    env,
    `/api/agents/${encodeURIComponent(agent.id)}/commands?region=garden-1`,
    commandInit({ id: "ordinary-local-move", type: "move", target }),
  );
  assert.equal(result.response.status, 202);
  assert.equal(result.body.accepted, true);
  assert.equal(result.body.handoff, undefined);
  assert.equal(entry.object.runtime.pendingCommands().length, 1);
});
