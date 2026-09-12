import assert from "node:assert/strict";
import test from "node:test";
import { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import { hexGridBoundaryCells } from "../dist-ts/src/hex-grid.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld, getTile } from "../dist-ts/src/world.js";

class MemoryStorage {
  values = new Map();
  alarm = null;
  alarmSetCount = 0;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarmSetCount += 1; this.alarm = +value; }
  async deleteAlarm() { this.alarm = null; }
}

class MemoryState {
  storage = new MemoryStorage();
  ready = Promise.resolve();
  blockConcurrencyWhile(callback) { this.ready = callback(); return this.ready; }
  getWebSockets() { return []; }
}

async function scenario({ tickScopedReference = false, startingTick = 0 } = {}) {
  const reads = [];
  const neighbors = new Map();
  const control = { failure: null, write: null, read: null };
  const neighbor = (id) => {
    if (!neighbors.has(id)) {
      neighbors.set(id, createInitialWorld({ seed: 425242, regionId: id, width: 40, height: 24 }));
    }
    return neighbors.get(id);
  };
  const env = {
    WORLD_SEED: "424242", REGION_IDS: "garden-1,garden-2,garden-3", TICK_MS: "10000",
    OPEN_COMMANDS: "false", COMMAND_TOKEN: "test-command", ADMIN_TOKEN: "test-admin",
    ASSETS: { fetch: async () => new Response("", { status: 404 }) },
    REGIONS: {
      idFromName: (id) => id,
      get: (id) => ({ fetch: async (input, init) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
        const url = new URL(request.url);
        const state = neighbor(id);
        if (request.method !== "GET") {
          state.revision += 1;
          if (control.write) return control.write(state, request);
          return Response.json({ ok: true });
        }
        const direction = url.searchParams.get("direction");
        reads.push({ regionId: id, direction, path: url.pathname, cells: url.searchParams.getAll("cell") });
        if (control.read) await control.read(state, request);
        if (control.failure === "transport") throw new Error("fixture edge unavailable");
        if (control.failure === "malformed") return new Response("{", { status: 200 });
        if (url.pathname === "/api/internal/halo/edge") {
          return Response.json({
            regionId: id, direction, tick: state.tick, revision: state.revision,
            tiles: hexGridBoundaryCells(state, direction).map((position) => ({
              position, tile: getTile(state, position),
            })),
          });
        }
        if (url.pathname === "/api/internal/pathogen/edge") {
          return Response.json({
            regionId: id, direction, tick: state.tick, revision: state.revision,
            agents: url.searchParams.getAll("cell").map((key) => {
              const [x, y] = key.split(",").map(Number);
              return { position: { x, y }, pressure: 0.7 };
            }),
          });
        }
        return new Response("", { status: 404 });
      } }),
    },
  };
  const ctx = new MemoryState();
  const object = new RegionDurableObject(ctx, env);
  await ctx.ready;
  await object.fetch(new Request("https://moyo.example/api/world/snapshot", {
    headers: { "x-moyo-region-internal": "garden-1" },
  }));
  const state = object.runtime.snapshot();
  state.tick = startingTick;
  state.revision = Math.max(state.revision, startingTick);
  for (const agent of state.agents) { agent.autonomy = false; delete agent.task; }
  for (const tile of state.tiles) {
    if (tile.resource?.kind === "wood" || tile.resource?.kind === "food") tile.resource.amount = 0;
  }
  object.runtime = new WorldRuntime({ state });
  await object.persist();
  if (tickScopedReference) {
    // Reproduce the previous per-tick cache lifetime using the real alarm path.
    // Nothing in simulation, remote payloads, RNG, or persistence is mocked.
    const runTick = object.runSingleAlarmTick.bind(object);
    object.runSingleAlarmTick = async () => {
      object.haloEdgeReadCache?.clear();
      return runTick();
    };
  }
  ctx.storage.alarmSetCount = 0;
  return { object, ctx, reads, neighbor, control };
}

for (const dueTicks of [12, 60]) {
  test(`${dueTicks}-tick debt shares stable halo reads inside a bounded batch`, async (context) => {
    let now = 1_800_004_000_000;
    context.mock.method(Date, "now", () => now);
    // Starting at T18 makes this 12-tick batch cross both autonomy T24 and
    // halo/pathogen T30 boundaries, so the observation cache is still tested
    // across independent expensive phases even with the smaller CPU budget.
    const reference = await scenario({ tickScopedReference: true, startingTick: 18 });
    const cached = await scenario({ startingTick: 18 });
    now += dueTicks * 10_000;
    await reference.object.alarm();
    await cached.object.alarm();
    assert.deepEqual(cached.object.runtime.snapshot(), reference.object.runtime.snapshot());
    assert.deepEqual(cached.ctx.storage.values.get("region"), reference.ctx.storage.values.get("region"));
    assert.equal(cached.object.runtime.snapshot().tick, 30);
    assert.equal(cached.ctx.storage.values.get("region").lastSimulatedAt, 1_800_004_120_000);
    const count = (entry, suffix) => entry.reads.filter((read) => read.path.endsWith(suffix)).length;
    assert.equal(count(reference, "/halo/edge"), 6);
    assert.equal(count(cached, "/halo/edge"), 6);
    assert.equal(count(cached, "/pathogen/edge"), count(reference, "/pathogen/edge"));
    assert.ok(count(cached, "/pathogen/edge") > 0, "the fixture must exercise the outer pathogen step too");
    const health = await (await cached.object.fetch(new Request("https://moyo.example/api/health", {
      headers: { "x-moyo-region-internal": "garden-1" },
    }))).json();
    assert.equal(health.virtualTicksDue, dueTicks - 12);
    assert.equal(health.virtualTicksRunnable, Math.min(12, dueTicks - 12));
    assert.equal(cached.ctx.storage.alarm, reference.ctx.storage.alarm);
    if (dueTicks > 12) {
      assert.equal(cached.ctx.storage.alarm, now + 1_000, "remaining debt should retry promptly");
    }
    assert.equal(cached.ctx.storage.alarmSetCount, reference.ctx.storage.alarmSetCount);
    assert.equal(cached.object.haloEdgeReadCache, undefined, "no cached observation may survive the alarm");
  });
}

test("successful full-edge observations expire at one second and retain region and direction scope", async (context) => {
  let now = 1_800_005_000_000;
  context.mock.method(Date, "now", () => now);
  const { object, reads, neighbor } = await scenario();
  const owner = object.beginHaloEdgeReadBatch();
  const first = await object.fetchNeighborEdge("garden-2", "west");
  neighbor("garden-2").revision = 1;
  now += 999;
  assert.equal((await object.fetchNeighborEdge("garden-2", "west")).revision, first.revision);
  now += 1;
  assert.equal((await object.fetchNeighborEdge("garden-2", "west")).revision, 1);
  await object.fetchNeighborEdge("garden-2", "east");
  await object.fetchNeighborEdge("garden-3", "west");
  assert.equal(reads.length, 4);
  object.endHaloEdgeReadBatch(owner);
  const nextOwner = object.beginHaloEdgeReadBatch();
  await object.fetchNeighborEdge("garden-2", "west");
  assert.equal(reads.length, 5, "a subsequent alarm must refetch even inside the previous TTL");
  object.endHaloEdgeReadBatch(nextOwner);
});

test("pending reads coalesce and a mutation cannot repopulate the cache with an older in-flight result", async (context) => {
  context.mock.method(Date, "now", () => 1_800_006_000_000);
  const { object, control, reads, neighbor } = await scenario();
  let release;
  control.read = () => new Promise((resolve) => { release = resolve; });
  const owner = object.beginHaloEdgeReadBatch();
  const pending = object.fetchNeighborEdge("garden-2", "west");
  assert.equal(object.fetchNeighborEdge("garden-2", "west"), pending);
  assert.equal(reads.length, 1);
  await object.withHaloEdgeMutation(async () => { neighbor("garden-2").revision = 1; });
  control.read = null;
  release();
  await pending;
  assert.equal((await object.fetchNeighborEdge("garden-2", "west")).revision, 1);
  assert.equal(reads.length, 2, "a response begun before invalidation cannot become the reusable observation");
  object.endHaloEdgeReadBatch(owner);
});

for (const failure of ["transport", "malformed"]) {
  test(`${failure} failures are retried in the next batch instead of every historical tick`, async (context) => {
    let now = 1_800_007_000_000;
    context.mock.method(Date, "now", () => now);
    context.mock.method(console, "debug", () => {});
    const { object, control, reads } = await scenario();
    control.failure = failure;
    const owner = object.beginHaloEdgeReadBatch();
    assert.equal(await object.fetchNeighborEdge("garden-2", "west"), undefined);
    now += 5_000;
    control.failure = null;
    assert.equal(await object.fetchNeighborEdge("garden-2", "west"), undefined);
    assert.equal(reads.length, 1);
    object.endHaloEdgeReadBatch(owner);
    const nextOwner = object.beginHaloEdgeReadBatch();
    assert.ok(await object.fetchNeighborEdge("garden-2", "west"));
    assert.equal(reads.length, 2);
    object.endHaloEdgeReadBatch(nextOwner);
  });
}

test("outgoing supply mutations invalidate before, during, and after an uncertain commit", async (context) => {
  context.mock.method(Date, "now", () => 1_800_008_000_000);
  const { object, reads, control } = await scenario();
  const owner = object.beginHaloEdgeReadBatch();
  assert.equal((await object.fetchNeighborEdge("garden-2", "west")).revision, 0);
  control.write = async () => {
    // The remote write has already advanced its revision. Even during the
    // awaited mutation, a concurrent observation must not reuse old cache data.
    assert.equal((await object.fetchNeighborEdge("garden-2", "west")).revision, 1);
    throw new Error("response lost after remote commit");
  };
  await assert.rejects(object.autonomyStub("garden-2").fetch(new Request(
    "https://moyo.internal/api/internal/autonomy/claim/settle",
    { method: "POST", body: JSON.stringify({ claimId: "fixture", settledAmount: 2 }) },
  )), /response lost/);
  assert.equal((await object.fetchNeighborEdge("garden-2", "west")).revision, 1);
  assert.equal(reads.length, 3, "reads during a mutation must not seed the post-mutation cache");
  object.endHaloEdgeReadBatch(owner);
});

test("incoming claim and handoff POST paths break the observation window", async (context) => {
  context.mock.method(Date, "now", () => 1_800_009_000_000);
  const { object, neighbor, reads } = await scenario();
  const owner = object.beginHaloEdgeReadBatch();
  await object.fetchNeighborEdge("garden-2", "west");
  neighbor("garden-2").revision = 1;
  const claim = await object.fetch(new Request("https://moyo.internal/api/internal/autonomy/claim/release", {
    method: "POST", headers: { "x-moyo-region-internal": "garden-1", "content-type": "application/json" },
    body: JSON.stringify({ claimId: "fixture" }),
  }));
  assert.equal(claim.status, 200);
  assert.equal((await object.fetchNeighborEdge("garden-2", "west")).revision, 1);
  neighbor("garden-2").revision = 2;
  await object.fetch(new Request("https://moyo.internal/api/admin/handoff", {
    method: "POST", headers: { "x-moyo-region-internal": "garden-1", "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal((await object.fetchNeighborEdge("garden-2", "west")).revision, 2);
  assert.equal(reads.length, 3);
  object.endHaloEdgeReadBatch(owner);
});

test("failed catch-up releases its cache and retains all unfinished virtual time", async (context) => {
  let now = 1_800_010_000_000;
  context.mock.method(Date, "now", () => now);
  const { object, ctx } = await scenario();
  now += 600_000;
  const tickMock = context.mock.method(object, "runSingleAlarmTick", async () => {
    await object.fetchNeighborEdge("garden-2", "west");
    throw new Error("fixture interrupted tick");
  });
  await assert.rejects(object.alarm(), /interrupted tick/);
  assert.equal(object.haloEdgeReadCache, undefined);
  assert.equal(object.runtime.snapshot().tick, 0);
  assert.equal(ctx.storage.values.get("region").lastSimulatedAt, 1_800_010_000_000);
  assert.equal(ctx.storage.alarm, now + 10_000);
  tickMock.mock.restore();
  await object.alarm();
  assert.equal(object.runtime.snapshot().tick, 12);
  assert.equal(ctx.storage.values.get("region").lastSimulatedAt, 1_800_010_120_000);
  assert.equal(ctx.storage.alarm, now + 1_000);
});
