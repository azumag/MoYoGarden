import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import { createRandom } from "../dist-ts/src/prng.js";
import { buildHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import {
  resourceRegrowthChanceWithHalo,
} from "../dist-ts/src/halo-environment.js";
import {
  hexGridHandoffTarget,
} from "../dist-ts/src/hex-grid.js";
import { resourceRegrowthChance, updateTileHydrology } from "../dist-ts/src/simulation.js";
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
    REGION_IDS: "garden-1,garden-2",
    TICK_MS: "10000",
    OPEN_COMMANDS: "false",
    COMMAND_TOKEN: "command-secret",
    ADMIN_TOKEN: "admin-secret",
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  };
  env.REGIONS = new MemoryNamespace(env);
  return env;
}

async function snapshot(env, regionId, passive = false) {
  const response = await worker.fetch(new Request(
    `https://moyo.example/api/world/snapshot?region=${regionId}`,
    passive ? { headers: { "x-moyo-prefetch": "1" } } : undefined,
  ), env);
  assert.equal(response.status, 200);
  return response.json();
}

test("scheduled region tick lets neighbor ghost water raise actual organic regrowth", async () => {
  const env = environment();
  await snapshot(env, "garden-1");
  await snapshot(env, "garden-2", true);
  const sourceEntry = env.REGIONS.entries.get("garden-1");
  const targetEntry = env.REGIONS.entries.get("garden-2");
  assert.ok(sourceEntry);
  assert.ok(targetEntry);
  await Promise.all([sourceEntry.state.ready, targetEntry.state.ready]);

  const source = sourceEntry.object.runtime.snapshot();
  const target = targetEntry.object.runtime.snapshot();
  const link = buildHexHaloLinks(source, ["garden-1", "garden-2"], "garden-1")
    .filter((entry) => entry.direction === "east")[11];
  assert.ok(link);
  assert.deepEqual(hexGridHandoffTarget(source, link.sourcePosition, "east"), link.neighborPosition);

  for (const tile of source.tiles) {
    tile.terrain = "plain";
    tile.elevation = 0.8;
    delete tile.resource;
    delete tile.flowTo;
    tile.drainage = 0;
    tile.erosionPressure = 0;
  }
  for (const agent of source.agents) {
    agent.autonomy = false;
    delete agent.task;
  }
  const organic = source.tiles[link.sourcePosition.y * source.width + link.sourcePosition.x];
  assert.ok(organic);
  organic.terrain = "forest";
  organic.resource = { kind: "wood", amount: 0, maxAmount: 10 };
  updateTileHydrology(source);
  source.tick = 29;

  const targetWater = target.tiles[link.neighborPosition.y * target.width + link.neighborPosition.x];
  assert.ok(targetWater);
  targetWater.terrain = "water";
  targetWater.elevation = 0;
  delete targetWater.resource;
  updateTileHydrology(target);

  const halo = [{
    ...link,
    tile: structuredClone(targetWater),
  }];
  const localChance = resourceRegrowthChance(source, organic);
  const haloChance = resourceRegrowthChanceWithHalo(source, organic, halo);
  const conditional = (haloChance - localChance) / (1 - localChance);
  assert.ok(conditional > 0);

  let selectedState;
  for (let seed = 1; seed < 200000; seed += 1) {
    const random = createRandom(seed);
    const baseDraw = random.next();
    const compensationDraw = random.next();
    if (baseDraw >= localChance && compensationDraw < conditional) {
      selectedState = seed;
      break;
    }
  }
  assert.ok(selectedState);
  source.rngState = selectedState;

  sourceEntry.object.runtime = new WorldRuntime({ state: source });
  targetEntry.object.runtime = new WorldRuntime({ state: target });
  await sourceEntry.object.persist();
  await targetEntry.object.persist();

  await sourceEntry.object.alarm();
  const after = sourceEntry.object.runtime.snapshot();
  assert.equal(after.tick, 30);
  const afterOrganic = after.tiles[organic.y * after.width + organic.x];
  assert.ok(afterOrganic);
  assert.equal(afterOrganic.resource.amount, 1);

  const targetHealth = await worker.fetch(new Request(
    "https://moyo.example/api/health?region=garden-2",
  ), env);
  const health = await targetHealth.json();
  assert.equal(health.tickMode, "idle", "halo environmental sampling must keep neighbor passive");
});
