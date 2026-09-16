from pathlib import Path
import re

path = Path("src/autonomy-region.ts")
text = path.read_text()

def replace_once(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, got {count}")
    text = text.replace(old, new, 1)

replace_once(
    '  claimId?: string;\n  desiredPosition?: GridPosition;',
    '  claimId?: string;\n'
    '  // Preserve the ultimate claim owner when gathered cargo is relayed through\n'
    '  // an intermediate region. Optional for rolling compatibility with old pending\n'
    '  // handoffs, where the immediate source remains the claim owner.\n'
    '  claimSourceRegionId?: string;\n'
    '  desiredPosition?: GridPosition;',
    'pending handoff claim origin',
)

marker = 'function returnHandoffForArrival(\n'
helper = '''function regionDistanceToTarget(
  regionId: string,
  targetRegionId: string,
): number | undefined {
  const region = regionAxialCoordinate(regionId);
  const target = regionAxialCoordinate(targetRegionId);
  if (region === undefined || target === undefined) return undefined;
  const dq = region.q - target.q;
  const dr = region.r - target.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/**
 * Return the remaining macro-hex distance only for a handoff that makes strict
 * progress toward the original material source. Direct legacy/historical source
 * IDs retain the old one-hop behavior even when an axial coordinate is missing.
 */
export function materialReturnHopDistance(
  currentRegionId: string,
  targetRegionId: string,
  candidateRegionId: string,
): number | undefined {
  if (candidateRegionId === targetRegionId) return 0;
  const currentDistance = regionDistanceToTarget(currentRegionId, targetRegionId);
  const candidateDistance = regionDistanceToTarget(candidateRegionId, targetRegionId);
  if (
    currentDistance === undefined ||
    candidateDistance === undefined ||
    candidateDistance >= currentDistance
  ) {
    return undefined;
  }
  return candidateDistance;
}

function returnHandoffForArrival(
'''
replace_once(marker, helper, 'return routing helper insertion')

pattern = re.compile(r'''function returnHandoffForArrival\(
  state: WorldState,
  agent: Agent,
  claim: AutonomousArrivalClaim,
\): PendingAutonomousHandoff \| undefined \{.*?
\}

function returnTravelTargetForArrival''', re.S)
replacement = '''function returnHandoffForArrival(
  state: WorldState,
  agent: Agent,
  claim: AutonomousArrivalClaim,
): PendingAutonomousHandoff | undefined {
  if (
    claim.returnToSourceStorage !== true ||
    inventoryAmount(agent) <= 0 ||
    hasAvailableFactionStorage(state, agent.factionId)
  ) return undefined;

  const candidates = boundaryDirections(state, agent.position).flatMap((direction) => {
    const step = HEX_GRID_DIRECTION_STEPS[direction];
    const desiredPosition = {
      x: agent.position.x + step.x,
      y: agent.position.y + step.y,
    };
    const transition = regionCellTransition(
      state.regionId,
      desiredPosition,
      state.width,
      state.height,
    );
    if (transition === undefined) return [];
    const targetDistance = materialReturnHopDistance(
      state.regionId,
      claim.sourceRegionId,
      transition.targetRegionId,
    );
    if (targetDistance === undefined) return [];
    return [{ direction, desiredPosition, transition, targetDistance }];
  }).sort((a, b) =>
    a.targetDistance - b.targetDistance ||
    directionRank(a.direction) - directionRank(b.direction) ||
    a.transition.targetRegionId.localeCompare(b.transition.targetRegionId)
  );
  const selected = candidates[0];
  if (selected === undefined) return undefined;
  const finalHop = selected.transition.targetRegionId === claim.sourceRegionId;
  return {
    transferId: `return:${state.regionId}:${agent.id}:${state.tick}:${selected.direction}`,
    agentId: agent.id,
    direction: selected.direction,
    resource: claim.resource,
    desiredPosition: selected.desiredPosition,
    ...(finalHop ? {} : {
      claimId: claim.claimId,
      claimSourceRegionId: claim.sourceRegionId,
      returnToSourceStorage: true,
    }),
  };
}

function returnTravelTargetForArrival'''
text, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit(f'returnHandoffForArrival replacement: {count}')

pattern = re.compile(r'''function returnTravelTargetForArrival\(
  state: WorldState,
  agent: Agent,
  claim: AutonomousArrivalClaim,
\): GridPosition \| undefined \{.*?
\}

function samePosition''', re.S)
replacement = '''function returnTravelTargetForArrival(
  state: WorldState,
  agent: Agent,
  claim: AutonomousArrivalClaim,
): GridPosition | undefined {
  if (
    claim.returnToSourceStorage !== true ||
    inventoryAmount(agent) <= 0 ||
    hasAvailableFactionStorage(state, agent.factionId)
  ) return undefined;

  const distances = localPathDistances(state, agent.position);
  const candidates: Array<{
    position: GridPosition;
    distance: number;
    direction: HexGridDirection;
    targetDistance: number;
    targetRegionId: string;
  }> = [];
  for (const tile of state.tiles) {
    const position = { x: tile.x, y: tile.y };
    if (!isHexGridCell(state, position) || !isPassable(state, position)) continue;
    const distance = distances.get(positionKey(position));
    if (distance === undefined) continue;
    for (const direction of boundaryDirections(state, position)) {
      const step = HEX_GRID_DIRECTION_STEPS[direction];
      const transition = regionCellTransition(
        state.regionId,
        { x: position.x + step.x, y: position.y + step.y },
        state.width,
        state.height,
      );
      if (transition === undefined) continue;
      const targetDistance = materialReturnHopDistance(
        state.regionId,
        claim.sourceRegionId,
        transition.targetRegionId,
      );
      if (targetDistance === undefined) continue;
      candidates.push({
        position,
        distance,
        direction,
        targetDistance,
        targetRegionId: transition.targetRegionId,
      });
    }
  }
  return candidates
    .sort((a, b) =>
      a.targetDistance - b.targetDistance ||
      a.distance - b.distance ||
      directionRank(a.direction) - directionRank(b.direction) ||
      a.targetRegionId.localeCompare(b.targetRegionId) ||
      a.position.y - b.position.y ||
      a.position.x - b.position.x
    )[0]?.position;
}

function samePosition'''
text, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit(f'returnTravelTargetForArrival replacement: {count}')

replace_once(
    '    const sourceRegionId = runtimeAccess(this).runtime.snapshot().regionId;\n'
    '    const target = this.autonomyStub(payload.toRegionId);',
    '    const sourceRegionId = pending.claimSourceRegionId ?? runtimeAccess(this).runtime.snapshot().regionId;\n'
    '    const target = this.autonomyStub(payload.toRegionId);',
    'preserve ultimate claim source',
)

old = '''    if (
      arrived?.autonomy !== true ||
      arrived.task?.source !== "autonomy" ||
      arrived.task.type !== "gather" ||
      arrived.task.resource !== body.resource
    ) {
      return new Response(JSON.stringify({ error: "arrival agent is not continuing this gather intent" }), {
        status: 409,
      });
    }'''
new = '''    const continuingGather =
      arrived?.autonomy === true &&
      arrived.task?.source === "autonomy" &&
      arrived.task.type === "gather" &&
      arrived.task.resource === body.resource;
    const continuingReturnDeposit =
      body.returnToSourceStorage === true &&
      arrived?.autonomy === true &&
      arrived.task?.source === "autonomy" &&
      arrived.task.type === "deposit";
    if (!continuingGather && !continuingReturnDeposit) {
      return new Response(JSON.stringify({ error: "arrival agent is not continuing this material intent" }), {
        status: 409,
      });
    }'''
replace_once(old, new, 'accept return deposit arrival')
path.write_text(text)

test_path = Path("tests/autonomy-material-return-relay.test.mjs")
test_path.write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject } from "../dist-ts/src/worker-entry.js";
import { hexGridCenter } from "../dist-ts/src/hex-grid.js";
import { materialReturnHopDistance } from "../dist-ts/src/autonomy-region.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";

const ARRIVAL_CLAIMS_KEY = "handoff:autonomy:arrival-claims:v1";
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

test("material return routing only accepts macro hops that strictly approach the claim origin", () => {
  assert.equal(materialReturnHopDistance("hex-q0-r0", "hex-q2-r0", "hex-q1-r0"), 1);
  assert.equal(materialReturnHopDistance("hex-q1-r0", "hex-q2-r0", "hex-q2-r0"), 0);
  assert.equal(materialReturnHopDistance("hex-q0-r0", "hex-q2-r0", "hex-q-1-r0"), undefined);
});

test("gathered cargo can relay through a storage-less intermediate region without losing its origin claim", async () => {
  const env = environment();
  const first = await assignRegion(env, "hex-q0-r0");
  const relay = await assignRegion(env, "hex-q1-r0");
  const origin = await assignRegion(env, "hex-q2-r0");
  const firstState = first.object.runtime.snapshot();
  firstState.tick = 24; firstState.structures = [];
  for (const candidate of firstState.agents) candidate.autonomy = false;
  const courier = firstState.agents[0]; assert.ok(courier);
  courier.autonomy = true; courier.position = hexGridCenter(firstState); courier.energy = 100; courier.capacity = 8;
  courier.inventory = { wood: 4, stone: 0, food: 0 }; courier.task = { source: "autonomy", issuedAtTick: 24, type: "deposit" };
  first.object.runtime = new WorldRuntime({ state: firstState }); await first.object.persist();
  const relayState = relay.object.runtime.snapshot(); relayState.structures = [];
  for (const candidate of relayState.agents) candidate.autonomy = false;
  relay.object.runtime = new WorldRuntime({ state: relayState }); await relay.object.persist();
  const originState = origin.object.runtime.snapshot();
  for (const candidate of originState.agents) candidate.autonomy = false;
  originState.structures = [{ id: "origin-storehouse", factionId: courier.factionId, type: "storehouse", position: hexGridCenter(originState), status: "active", progress: 1, requiredProgress: 1, storage: { wood: 0, stone: 0, food: 0 } }];
  origin.object.runtime = new WorldRuntime({ state: originState }); await origin.object.persist();
  await first.state.storage.put(ARRIVAL_CLAIMS_KEY, [{ claimId: "two-hop-return", sourceRegionId: "hex-q2-r0", agentId: courier.id, resource: "wood", registeredAtTick: 24, gatheredAmount: 4, settledAmount: 4, returnToSourceStorage: true }]);
  let deposited = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await first.object.alarm(); await relay.object.alarm(); await origin.object.alarm();
    const storehouse = origin.object.runtime.snapshot().structures.find((entry) => entry.id === "origin-storehouse");
    if ((storehouse?.storage.wood ?? 0) >= 4) { deposited = true; break; }
  }
  assert.equal(deposited, true, "cargo should cross both ownership handoffs and deposit at the origin storehouse");
  const relayClaims = await relay.state.storage.get(ARRIVAL_CLAIMS_KEY);
  assert.ok(relayClaims === undefined || relayClaims.length === 0 || relayClaims.every((entry) => entry.sourceRegionId === "hex-q2-r0"));
});
''')
