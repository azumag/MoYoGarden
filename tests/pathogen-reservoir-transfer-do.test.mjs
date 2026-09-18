import assert from "node:assert/strict";
import test from "node:test";
import { HEX_GRID_DIRECTION_STEPS, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import {
  applyPathogenSteps,
  pathogenReservoirOutboundIntents,
  tilePathogenReservoir,
} from "../dist-ts/src/pathogen.js";
import {
  PATHOGEN_RESERVOIR_TRANSFER_ATTEMPT_BUDGET,
  RegionDurableObject,
  selectPathogenReservoirAttemptIds,
} from "../dist-ts/src/pathogen-region.js";
import { regionCellTransition, regionGlobalCellOrigin } from "../dist-ts/src/region-topology.js";
import { sampleWorldWind } from "../dist-ts/src/world-scale.js";

class MemoryStorage {
  constructor() { this.values = new Map(); this.alarm = null; }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value instanceof Date ? value.getTime() : Number(value); }
  async deleteAlarm() { this.alarm = null; }
  async transaction(callback) { return await callback(this); }
}

class MemoryState {
  constructor(storage = new MemoryStorage()) {
    this.storage = storage;
    this.sockets = [];
    this.ready = Promise.resolve();
  }
  blockConcurrencyWhile(callback) { this.ready = callback(); return this.ready; }
  acceptWebSocket(socket) { this.sockets.push(socket); }
  getWebSockets() { return [...this.sockets]; }
}

function fixture() {
  const entries = new Map();
  const env = {
    WORLD_SEED: "424242",
    REGION_IDS: "garden-1,garden-2,garden-3",
    DEFAULT_REGION_ID: "garden-1",
    TICK_MS: "10000",
    OPEN_COMMANDS: "false",
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  };
  const instantiate = (id, storage = new MemoryStorage()) => {
    const state = new MemoryState(storage);
    const object = new RegionDurableObject(state, env);
    const entry = { id, storage, state, object };
    entries.set(id, entry);
    return entry;
  };
  const entry = (id) => entries.get(id) ?? instantiate(id);
  env.REGIONS = {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (request) => {
        const target = entry(id);
        await target.state.ready;
        return target.object.fetch(request);
      },
    }),
  };
  return {
    env,
    entries,
    entry,
    recreate(id) {
      const current = entry(id);
      return instantiate(id, current.storage);
    },
  };
}

function internalRequest(regionId, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-moyo-region-internal", regionId);
  return new Request(`https://moyo.internal${path}`, { ...init, headers });
}

function findWindCrossing(regionId, state) {
  const origin = regionGlobalCellOrigin(regionId, state.width, state.height);
  assert.ok(origin);
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    const wind = sampleWorldWind(424242, origin.x + tile.x, origin.y + tile.y);
    const step = HEX_GRID_DIRECTION_STEPS[wind.direction];
    const desiredPosition = { x: tile.x + step.x, y: tile.y + step.y };
    const transition = regionCellTransition(regionId, desiredPosition, state.width, state.height);
    if (transition !== undefined && wind.strength > 0.05) {
      return { tile, wind, desiredPosition, transition, origin };
    }
  }
  throw new Error("expected at least one wind-driven boundary crossing");
}

test("outbound reservoir planner emits only exact cross-DO low-level transport", () => {
  const extent = { width: 40, height: 24 };
  const origin = regionGlobalCellOrigin("garden-1", extent.width, extent.height);
  assert.ok(origin);
  let chosen;
  for (let y = 0; y < extent.height && chosen === undefined; y += 1) {
    for (let x = 0; x < extent.width; x += 1) {
      if (!isHexGridCell(extent, { x, y })) continue;
      const wind = sampleWorldWind(424242, origin.x + x, origin.y + y);
      const step = HEX_GRID_DIRECTION_STEPS[wind.direction];
      const desiredPosition = { x: x + step.x, y: y + step.y };
      const transition = regionCellTransition("garden-1", desiredPosition, extent.width, extent.height);
      if (transition !== undefined && wind.strength > 0.05) {
        chosen = { position: { x, y }, desiredPosition, wind, transition };
        break;
      }
    }
  }
  assert.ok(chosen);
  const state = {
    ...extent,
    tiles: [{ ...chosen.position, terrain: "plain", pathogenReservoir: 0.8 }],
  };
  const environment = { worldSeed: 424242, originX: origin.x, originY: origin.y };
  const intents = pathogenReservoirOutboundIntents(state, environment);
  assert.equal(intents.length, 1);
  assert.deepEqual(intents[0].sourcePosition, chosen.position);
  assert.deepEqual(intents[0].desiredPosition, chosen.desiredPosition);
  assert.ok(Math.abs(intents[0].burden - 0.8 * chosen.wind.strength * 0.03) < 1e-12);
  assert.equal(
    regionCellTransition("garden-1", intents[0].desiredPosition, 40, 24)?.targetRegionId,
    chosen.transition.targetRegionId,
  );
});

test("pathogen reservoir retry selection stays bounded and rotates across backlog", () => {
  const records = Array.from({ length: 10 }, (_entry, index) => ({
    transferId: `transfer-${index.toString().padStart(2, "0")}`,
  }));
  const first = selectPathogenReservoirAttemptIds(records, 0);
  const second = selectPathogenReservoirAttemptIds(records, 1);
  assert.equal(first.length, PATHOGEN_RESERVOIR_TRANSFER_ATTEMPT_BUDGET);
  assert.equal(new Set(first).size, first.length);
  assert.equal(second.length, PATHOGEN_RESERVOIR_TRANSFER_ATTEMPT_BUDGET);
  assert.notDeepEqual(second, first, "persistent retry backlog should rotate with simulation tick");

  const seen = new Set();
  for (let tick = 0; tick < records.length; tick += 1) {
    for (const transferId of selectPathogenReservoirAttemptIds(records, tick)) {
      seen.add(transferId);
    }
  }
  assert.equal(seen.size, records.length, "bounded retry rotation must not starve deferred routes");
  assert.deepEqual(selectPathogenReservoirAttemptIds(records, 0, 0), []);
});

test("cross-DO reservoir transfer debits source mass, journals delivery, and deduplicates retries", async () => {
  const world = fixture();
  const sourceId = "garden-1";
  const source = world.entry(sourceId);
  await source.state.ready;
  const initial = await (await source.object.fetch(
    internalRequest(sourceId, "/api/world/snapshot"),
  )).json();
  const crossing = findWindCrossing(sourceId, initial);

  const stored = await source.storage.get("region");
  const storedTile = stored.state.tiles.find(
    (tile) => tile.x === crossing.tile.x && tile.y === crossing.tile.y,
  );
  assert.ok(storedTile);
  storedTile.pathogenReservoir = 0.8;
  storedTile.drainage = 0;
  delete storedTile.flowTo;
  await source.storage.put("region", stored);
  const restored = world.recreate(sourceId);
  await restored.state.ready;

  for (let index = 0; index < 6; index += 1) await restored.object.alarm();

  const target = world.entry(crossing.transition.targetRegionId);
  await target.state.ready;
  const inbox = await target.storage.get("pathogen:reservoir:incoming:v1");
  assert.ok(Array.isArray(inbox));
  const pending = inbox.reduce((sum, route) => sum + route.pendingBurden, 0);
  assert.ok(pending > 0, "neighbor must own accepted reservoir mass before source forgets it");
  assert.deepEqual(
    await restored.storage.get("pathogen:reservoir:outgoing:v1"),
    [],
    "source outbox should clear only after target acknowledgement",
  );

  const sourceAfter = await (await restored.object.fetch(
    internalRequest(sourceId, "/api/world/snapshot"),
  )).json();
  const sourceTile = sourceAfter.tiles.find(
    (tile) => tile.x === crossing.tile.x && tile.y === crossing.tile.y,
  );
  assert.ok(sourceTile);
  assert.ok(tilePathogenReservoir(sourceTile) < 0.8);

  await target.object.alarm();
  const targetAfter = await (await target.object.fetch(
    internalRequest(crossing.transition.targetRegionId, "/api/world/snapshot"),
  )).json();
  const targetTile = targetAfter.tiles.find(
    (tile) => tile.x === crossing.transition.targetPosition.x && tile.y === crossing.transition.targetPosition.y,
  );
  assert.ok(targetTile);
  assert.ok(tilePathogenReservoir(targetTile) > 0);
  const drained = await target.storage.get("pathogen:reservoir:incoming:v1");
  assert.ok(drained.every((route) => route.pendingBurden === 0));

  const route = drained[0];
  assert.ok(route);
  const duplicateBody = {
    transferId: `${route.routeKey}@${route.lastAcceptedTick}`,
    fromRegionId: route.fromRegionId,
    toRegionId: crossing.transition.targetRegionId,
    sourcePosition: route.sourcePosition,
    desiredPosition: crossing.desiredPosition,
    targetPosition: route.targetPosition,
    burden: pending,
    createdAtTick: route.lastAcceptedTick,
  };
  const duplicate = await target.object.fetch(internalRequest(
    crossing.transition.targetRegionId,
    "/api/internal/pathogen/reservoir/transfer",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(duplicateBody),
    },
  ));
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).phase, "duplicate");
  assert.ok((await target.storage.get("pathogen:reservoir:incoming:v1")).every(
    (entry) => entry.pendingBurden === 0,
  ));
});
