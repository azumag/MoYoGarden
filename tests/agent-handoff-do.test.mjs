import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import { globalHandoffAgentId } from "../dist-ts/src/agent-ownership.js";
import { hexGridBoundaryCells } from "../dist-ts/src/hex-grid.js";
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
    this.failCommitOnce = new Set();
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
        if (url.pathname === "/api/internal/handoff/commit" && this.failCommitOnce.delete(id)) {
          return new Response(JSON.stringify({ error: "simulated commit transport loss" }), {
            status: 503,
            headers: { "content-type": "application/json" },
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

async function placeAgentOnBoundary(env, regionId, direction, agentIndex = 0) {
  await publicJson(env, `/api/world/snapshot?region=${regionId}`);
  const entry = env.REGIONS.entries.get(regionId);
  assert.ok(entry);
  await entry.state.ready;
  const runtime = entry.object.runtime;
  const state = runtime.snapshot();
  const agent = state.agents[agentIndex];
  assert.ok(agent);
  const cell = hexGridBoundaryCells(state, direction)[11];
  assert.ok(cell);
  const tile = state.tiles[cell.y * state.width + cell.x];
  assert.ok(tile);
  tile.terrain = "plain";
  delete tile.resource;
  agent.position = { ...cell };
  agent.autonomy = false;
  delete agent.task;
  entry.object.runtime = new WorldRuntime({ state });
  await entry.object.persist();
  return { agentId: agent.id, cell };
}

function adminHandoffBody(value) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer admin-secret",
    },
    body: JSON.stringify(value),
  };
}

test("public Worker never proxies internal handoff routes", async () => {
  const env = environment();
  const response = await worker.fetch(new Request(
    "https://moyo.example/api/internal/handoff/prepare?region=garden-1",
    { method: "POST", body: "{}" },
  ), env);
  assert.equal(response.status, 404);
  assert.equal(env.REGIONS.entries.size, 0);
});

test("admin handoff moves one BOT between two Durable Objects and retry stays idempotent", async () => {
  const env = environment();
  const { agentId } = await placeAgentOnBoundary(env, "garden-1", "east");
  const transferId = "integration-east-1";

  const first = await publicJson(
    env,
    "/api/admin/handoff?region=garden-1",
    adminHandoffBody({ transferId, agentId, direction: "east" }),
  );
  assert.equal(first.response.status, 200);
  assert.equal(first.body.phase, "committed");
  assert.equal(first.body.toRegionId, "garden-2");

  const source = (await publicJson(env, "/api/world/snapshot?region=garden-1")).body;
  const target = (await publicJson(env, "/api/world/snapshot?region=garden-2")).body;
  const globalId = globalHandoffAgentId(agentId, "garden-1");
  assert.equal(source.agents.some((agent) => agent.id === agentId), false);
  assert.equal(target.agents.filter((agent) => agent.id === globalId).length, 1);
  assert.equal(target.agents.filter((agent) => agent.id === agentId).length, 1, "unrelated legacy local remains");

  const retry = await publicJson(
    env,
    "/api/admin/handoff?region=garden-1",
    adminHandoffBody({ transferId }),
  );
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.phase, "committed");
  const targetAfterRetry = (await publicJson(env, "/api/world/snapshot?region=garden-2")).body;
  assert.equal(targetAfterRetry.agents.filter((agent) => agent.id === globalId).length, 1);

  const sourceJournal = env.REGIONS.entries.get("garden-1").state.storage.values.get("handoff:outgoing:v1");
  const targetJournal = env.REGIONS.entries.get("garden-2").state.storage.values.get("handoff:incoming:v1");
  assert.equal(sourceJournal[0].phase, "committed");
  assert.equal(targetJournal[0].phase, "committed");
});

test("commit transport failure leaves recoverable detached/prepared journals and retry completes", async () => {
  const env = environment();
  const { agentId } = await placeAgentOnBoundary(env, "garden-1", "northEast");
  const transferId = "integration-ne-retry";
  env.REGIONS.failCommitOnce.add("garden-3");

  const failed = await publicJson(
    env,
    "/api/admin/handoff?region=garden-1",
    adminHandoffBody({ transferId, agentId, direction: "northEast" }),
  );
  assert.equal(failed.response.status, 502);

  const sourceAfterFailure = (await publicJson(env, "/api/world/snapshot?region=garden-1")).body;
  const targetAfterFailure = (await publicJson(env, "/api/world/snapshot?region=garden-3")).body;
  const globalId = globalHandoffAgentId(agentId, "garden-1");
  assert.equal(sourceAfterFailure.agents.some((agent) => agent.id === agentId), false);
  assert.equal(targetAfterFailure.agents.some((agent) => agent.id === globalId), false);
  assert.equal(
    env.REGIONS.entries.get("garden-1").state.storage.values.get("handoff:outgoing:v1")[0].phase,
    "detached",
  );
  assert.equal(
    env.REGIONS.entries.get("garden-3").state.storage.values.get("handoff:incoming:v1")[0].phase,
    "prepared",
  );

  const retry = await publicJson(
    env,
    "/api/admin/handoff?region=garden-1",
    adminHandoffBody({ transferId }),
  );
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.phase, "committed");
  const targetRecovered = (await publicJson(env, "/api/world/snapshot?region=garden-3")).body;
  assert.equal(targetRecovered.agents.filter((agent) => agent.id === globalId).length, 1);
  assert.equal(
    env.REGIONS.entries.get("garden-1").state.storage.values.get("handoff:outgoing:v1")[0].phase,
    "committed",
  );
  assert.equal(
    env.REGIONS.entries.get("garden-3").state.storage.values.get("handoff:incoming:v1")[0].phase,
    "committed",
  );
});

test("handoff admin route requires admin authentication", async () => {
  const env = environment();
  const response = await worker.fetch(new Request(
    "https://moyo.example/api/admin/handoff?region=garden-1",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transferId: "unauthorized", agentId: "agent-ember-builder", direction: "east" }),
    },
  ), env);
  assert.equal(response.status, 401);
});
