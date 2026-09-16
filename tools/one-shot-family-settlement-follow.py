from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}")
    p.write_text(text.replace(old, new, 1))


# Keep the persisted Agent schema version unchanged; the new route marker is optional.
replace_once(
    "src/protocol.ts",
    """  socialMemory?: AgentSocialMemory[];
  settlementMigrationOriginRegionId?: string;
  task?: AgentTask;
""",
    """  socialMemory?: AgentSocialMemory[];
  settlementMigrationOriginRegionId?: string;
  // Optional bounded family-migration goal. It carries only a region identity,
  // never a source-local coordinate or structure ID, so ownership handoff can
  // safely preserve it across intermediate regions without a schema bump.
  settlementFamilyTargetRegionId?: string;
  task?: AgentTask;
""",
)

# Add bounded family registration + monotonic one-hop planning on the existing halo.
replace_once(
    "src/settlement-migration.ts",
    """export interface AutonomousSettlementMigrationPlan {
  agentId: string;
  direction: HexGridDirection;
  neighborRegionId: string;
  boundaryTarget: GridPosition;
  issuedAtTick: number;
  startedAtTick: number;
}

interface SettlementNeighborSupport {
""",
    """export interface AutonomousSettlementMigrationPlan {
  agentId: string;
  direction: HexGridDirection;
  neighborRegionId: string;
  boundaryTarget: GridPosition;
  issuedAtTick: number;
  startedAtTick: number;
}

export interface SettlementFamilyFollowPlan {
  agentId: string;
  direction: HexGridDirection;
  neighborRegionId: string;
  targetRegionId: string;
  boundaryTarget: GridPosition;
}

export interface SettlementFamilyRegistrationResult {
  agentIds: string[];
  candidateCount: number;
}

const MAX_SETTLEMENT_FAMILY_FOLLOWERS = 6;
const GLOBAL_AGENT_PREFIX = "agent-global:";

function sourceResidentGlobalId(state: WorldState, agentId: string): string {
  return agentId.startsWith(GLOBAL_AGENT_PREFIX)
    ? agentId
    : `${GLOBAL_AGENT_PREFIX}${state.regionId}:${agentId}`;
}

function sourceResidentMatchesReference(
  state: WorldState,
  resident: Agent,
  referenceId: string | undefined,
): boolean {
  return referenceId !== undefined
    && (resident.id === referenceId || sourceResidentGlobalId(state, resident.id) === referenceId);
}

function familyFollowPriority(agent: Agent): number {
  if (agent.pregnancy !== undefined) return 0;
  if (agent.lifeStage === "infant" || agent.lifeStage === "juvenile") return 2;
  return 1;
}

export function registerSettlementFamilyFollowers(
  state: WorldState,
  pioneerId: string,
  targetRegionId: string,
  factionId: string,
  pioneerPartnerId?: string,
): SettlementFamilyRegistrationResult {
  if (
    regionAxialCoordinate(targetRegionId) === undefined
    || sameSettlementRegion(state.regionId, targetRegionId)
  ) {
    return { agentIds: [], candidateCount: 0 };
  }

  const priorities = new Map<string, number>();
  const add = (agent: Agent | undefined, priority: number): void => {
    if (
      agent === undefined
      || agent.hp <= 0
      || agent.factionId !== factionId
      || sourceResidentMatchesReference(state, agent, pioneerId)
    ) return;
    const previous = priorities.get(agent.id);
    if (previous === undefined || priority < previous) priorities.set(agent.id, priority);
  };

  for (const relative of state.agents) {
    if (relative.factionId !== factionId || relative.hp <= 0) continue;
    if (sourceResidentMatchesReference(state, relative, pioneerPartnerId)) add(relative, 0);
    if (relative.pregnancy?.partnerId === pioneerId) add(relative, 0);
    if (
      (relative.lifeStage === "infant" || relative.lifeStage === "juvenile")
      && relative.parents?.includes(pioneerId)
    ) {
      add(relative, 2);
      const caregiverId = dependentCaregiverId(state, relative);
      add(state.agents.find((agent) => agent.id === caregiverId), 0);
      for (const parentId of relative.parents) {
        if (parentId === pioneerId) continue;
        add(state.agents.find((agent) =>
          sourceResidentMatchesReference(state, agent, parentId)
        ), 1);
      }
    }
  }

  const selected = [...priorities]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SETTLEMENT_FAMILY_FOLLOWERS)
    .map(([agentId]) => agentId);
  for (const agentId of selected) {
    const agent = state.agents.find((entry) => entry.id === agentId);
    if (agent !== undefined) agent.settlementFamilyTargetRegionId = targetRegionId;
  }
  return { agentIds: selected, candidateCount: priorities.size };
}

export function settlementFamilyAdmissionReady(state: WorldState, factionId: string): boolean {
  const faction = getFaction(state, factionId);
  if (faction === undefined) return false;
  const activeStructures = state.structures.filter((structure) =>
    structure.factionId === factionId && structure.status === "active"
  );
  if (!activeStructures.some((structure) => structure.type === "camp")) return false;
  const storageHeadroom = activeStructures.reduce(
    (sum, structure) => sum + Math.max(
      0,
      BUILD_RECIPES[structure.type].storageCapacity - inventoryTotal(structure.storage),
    ),
    0,
  );
  if (storageHeadroom <= 0) return false;
  return faction.resources.food > 0 || state.tiles.some((tile) =>
    isHexGridCell(state, tile)
    && tile.terrain !== "water"
    && tile.resource?.kind === "food"
    && tile.resource.amount > 0
  );
}

export function hasSettlementFamilyFollow(state: WorldState): boolean {
  return state.agents.some((agent) =>
    agent.hp > 0
    && agent.settlementFamilyTargetRegionId !== undefined
    && !sameSettlementRegion(state.regionId, agent.settlementFamilyTargetRegionId)
  );
}

export function planSettlementFamilyFollow(
  state: WorldState,
  halo: readonly HexHaloTile[],
): SettlementFamilyFollowPlan | undefined {
  const currentAxial = regionAxialCoordinate(state.regionId);
  if (currentAxial === undefined) return undefined;
  const crowdingByPosition = new Map<string, number>();
  for (const occupant of state.agents) {
    const key = positionKey(occupant.position);
    crowdingByPosition.set(key, (crowdingByPosition.get(key) ?? 0) + 1);
  }

  const followers = state.agents
    .filter((agent) =>
      agent.hp > 0
      && agent.energy > 0
      && agent.settlementFamilyTargetRegionId !== undefined
      && !sameSettlementRegion(state.regionId, agent.settlementFamilyTargetRegionId)
      && agent.task?.source !== "external"
    )
    .sort((a, b) => familyFollowPriority(a) - familyFollowPriority(b) || a.id.localeCompare(b.id));

  for (const agent of followers) {
    const targetRegionId = agent.settlementFamilyTargetRegionId;
    if (targetRegionId === undefined) continue;
    const targetAxial = regionAxialCoordinate(targetRegionId);
    if (targetAxial === undefined) continue;
    const currentDistance = hexDistance(currentAxial, targetAxial);
    if (currentDistance <= 0) continue;
    const paths = localPathScores(state, agent.position, crowdingByPosition);
    const dependent = agent.lifeStage === "infant" || agent.lifeStage === "juvenile";
    const energyBudget = Math.max(0, agent.energy - (dependent ? 0 : LOW_ENERGY_THRESHOLD));
    let best: { entry: HexHaloTile; distance: number; crowding: number; remaining: number } | undefined;
    for (const entry of halo) {
      if (entry.tile.terrain === "water") continue;
      const neighborAxial = regionAxialCoordinate(entry.neighborRegionId);
      if (neighborAxial === undefined) continue;
      const remaining = hexDistance(neighborAxial, targetAxial);
      if (remaining >= currentDistance) continue;
      const path = paths.get(positionKey(entry.sourcePosition));
      if (path === undefined || path.distance > energyBudget) continue;
      const candidate = {
        entry,
        distance: path.distance,
        crowding: path.crowding,
        remaining,
      };
      if (
        best === undefined
        || candidate.remaining < best.remaining
        || (candidate.remaining === best.remaining && candidate.distance + candidate.crowding < best.distance + best.crowding)
        || (
          candidate.remaining === best.remaining
          && candidate.distance + candidate.crowding === best.distance + best.crowding
          && directionRank(candidate.entry.direction) < directionRank(best.entry.direction)
        )
        || (
          candidate.remaining === best.remaining
          && candidate.distance + candidate.crowding === best.distance + best.crowding
          && directionRank(candidate.entry.direction) === directionRank(best.entry.direction)
          && candidate.entry.neighborRegionId.localeCompare(best.entry.neighborRegionId) < 0
        )
      ) {
        best = candidate;
      }
    }
    if (best !== undefined) {
      return {
        agentId: agent.id,
        direction: best.entry.direction,
        neighborRegionId: best.entry.neighborRegionId,
        targetRegionId,
        boundaryTarget: { ...best.entry.sourcePosition },
      };
    }
  }
  return undefined;
}

interface SettlementNeighborSupport {
""",
)

# Dependents with a cross-region family goal must not have their route overwritten
# by the region-local caregiver-follow behavior during the simulation tick.
replace_once(
    "src/runtime.ts",
    """    if (commandedAgentIds.has(dependent.id) || dependent.task?.source === "external") continue;

    const caregiverId = dependentCaregiverId(state, dependent);
""",
    """    if (commandedAgentIds.has(dependent.id) || dependent.task?.source === "external") continue;
    if (dependent.settlementFamilyTargetRegionId !== undefined) continue;

    const caregiverId = dependentCaregiverId(state, dependent);
""",
)

# Clear the bounded goal only at the final region; intermediate handoffs retain it.
replace_once(
    "src/agent-ownership.ts",
    """  arrived.id = arrivedId;
  arrived.position = { ...targetPosition };
  // Keep lineage, active pregnancy, and durable social references on the same
""",
    """  arrived.id = arrivedId;
  arrived.position = { ...targetPosition };
  if (arrived.settlementFamilyTargetRegionId === targetState.regionId) {
    delete arrived.settlementFamilyTargetRegionId;
  }
  // Keep lineage, active pregnancy, and durable social references on the same
""",
)

# Wire registration, destination admission, and sequential crash-safe family handoff.
replace_once(
    "src/autonomy-region.ts",
    """import {
  planAutonomousSettlementMigration,
  prepareSettlementMigrationKit,
  shouldScoutSettlementMigration,
  type AutonomousSettlementMigrationPlan,
} from "./settlement-migration.js";
""",
    """import {
  hasSettlementFamilyFollow,
  planAutonomousSettlementMigration,
  planSettlementFamilyFollow,
  prepareSettlementMigrationKit,
  registerSettlementFamilyFollowers,
  settlementFamilyAdmissionReady,
  shouldScoutSettlementMigration,
  type AutonomousSettlementMigrationPlan,
} from "./settlement-migration.js";
""",
)

replace_once(
    "src/autonomy-region.ts",
    """  returnToSourceStorage?: boolean;
  settlementMigration?: boolean;
}
""",
    """  returnToSourceStorage?: boolean;
  settlementMigration?: boolean;
  settlementFamilyFollow?: boolean;
}
""",
)

replace_once(
    "src/autonomy-region.ts",
    """const INTERNAL_STORAGE_RELEASE_PATH = `${INTERNAL_AUTONOMY_PREFIX}storage/release`;
const LOW_ENERGY_THRESHOLD = 18;
""",
    """const INTERNAL_STORAGE_RELEASE_PATH = `${INTERNAL_AUTONOMY_PREFIX}storage/release`;
const INTERNAL_SETTLEMENT_FAMILY_REGISTER_PATH = `${INTERNAL_AUTONOMY_PREFIX}settlement/family/register`;
const LOW_ENERGY_THRESHOLD = 18;
""",
)

replace_once(
    "src/autonomy-region.ts",
    """  private async ensureAutonomyAssigned(request: Request): Promise<Response | undefined> {
""",
    """  private async registerSettlementFamilyFollow(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "request body must be valid JSON" }), { status: 400 });
    }
    if (
      !isRecord(body)
      || typeof body.pioneerId !== "string"
      || typeof body.targetRegionId !== "string"
      || typeof body.factionId !== "string"
      || (body.pioneerPartnerId !== undefined && typeof body.pioneerPartnerId !== "string")
      || regionAxialCoordinate(body.targetRegionId) === undefined
    ) {
      return new Response(JSON.stringify({ error: "invalid settlement family registration" }), { status: 400 });
    }
    const state = runtimeAccess(this).runtime.snapshot();
    const result = registerSettlementFamilyFollowers(
      state,
      body.pioneerId,
      body.targetRegionId,
      body.factionId,
      body.pioneerPartnerId,
    );
    if (result.agentIds.length > 0) this.replaceRuntimeState(state);
    return new Response(JSON.stringify({
      ok: true,
      targetRegionId: body.targetRegionId,
      registeredAgentIds: result.agentIds,
      candidateCount: result.candidateCount,
    }), { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  private async notifySettledPioneers(state: WorldState): Promise<void> {
    let dirty = false;
    for (const pioneer of state.agents) {
      const sourceRegionId = pioneer.settlementMigrationOriginRegionId;
      if (sourceRegionId === undefined) continue;
      const sourceAxial = regionAxialCoordinate(sourceRegionId);
      const currentAxial = regionAxialCoordinate(state.regionId);
      if (
        sourceRegionId === state.regionId
        || (
          sourceAxial !== undefined
          && currentAxial !== undefined
          && sourceAxial.q === currentAxial.q
          && sourceAxial.r === currentAxial.r
        )
      ) {
        delete pioneer.settlementMigrationOriginRegionId;
        dirty = true;
        continue;
      }
      if (!settlementFamilyAdmissionReady(state, pioneer.factionId)) continue;
      try {
        const response = await this.autonomyStub(sourceRegionId).fetch(new Request(
          `https://moyo.internal${INTERNAL_SETTLEMENT_FAMILY_REGISTER_PATH}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-moyo-region-internal": sourceRegionId,
            },
            body: JSON.stringify({
              pioneerId: pioneer.id,
              targetRegionId: state.regionId,
              factionId: pioneer.factionId,
              ...(pioneer.pregnancy?.partnerId === undefined
                ? {}
                : { pioneerPartnerId: pioneer.pregnancy.partnerId }),
            }),
          },
        ));
        if (!response.ok) continue;
        delete pioneer.settlementMigrationOriginRegionId;
        pioneer.status = "frontier camp established; family route opened";
        dirty = true;
      } catch {
        // Keep the origin marker and retry idempotently on the next Alarm.
      }
    }
    if (dirty) this.replaceRuntimeState(state);
  }

  private async advanceSettlementFamilyFollow(
    state: WorldState,
    halo: readonly HexHaloTile[],
  ): Promise<boolean> {
    const plan = planSettlementFamilyFollow(state, halo);
    if (plan === undefined) return false;
    const agent = state.agents.find((entry) => entry.id === plan.agentId);
    if (agent === undefined || agent.task?.source === "external") return false;
    if (samePosition(agent.position, plan.boundaryTarget)) {
      const step = HEX_GRID_DIRECTION_STEPS[plan.direction];
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
      if (transition?.targetRegionId !== plan.neighborRegionId) return false;
      if (agent.task?.source === "autonomy") delete agent.task;
      agent.status = `following family toward ${plan.targetRegionId}`;
      this.replaceRuntimeState(state);
      const handoff: PendingAutonomousHandoff = {
        transferId: `family:${state.regionId}:${agent.id}:${state.tick}:${plan.direction}`,
        agentId: agent.id,
        direction: plan.direction,
        resource: undefined,
        desiredPosition,
        settlementFamilyFollow: true,
      };
      await this.autonomyState.storage.put(AUTONOMOUS_HANDOFF_KEY, handoff);
      await this.attemptPendingHandoff(handoff);
      return true;
    }
    agent.task = {
      source: "autonomy",
      issuedAtTick: state.tick,
      type: "move",
      target: { ...plan.boundaryTarget },
    };
    agent.status = `traveling to family in ${plan.targetRegionId}`;
    this.replaceRuntimeState(state);
    return true;
  }

  private async ensureAutonomyAssigned(request: Request): Promise<Response | undefined> {
""",
)

replace_once(
    "src/autonomy-region.ts",
    """    const failedSettlementMigration =
      pending.settlementMigration === true &&
      agent?.task?.source === "autonomy" &&
      agent.task.type === "move";
    if (failedResourceHandoff || failedSettlementMigration) {
""",
    """    const failedSettlementMigration =
      pending.settlementMigration === true &&
      agent?.task?.source === "autonomy" &&
      agent.task.type === "move";
    const failedSettlementFamilyFollow =
      pending.settlementFamilyFollow === true
      && agent?.task?.source === "autonomy"
      && agent.task.type === "move";
    if (failedResourceHandoff || failedSettlementMigration || failedSettlementFamilyFollow) {
""",
)

replace_once(
    "src/autonomy-region.ts",
    """    if (request.method === "POST" && url.pathname === INTERNAL_STORAGE_RELEASE_PATH) {
      return this.releaseDestinationStorage(request);
    }
    if (request.method === "POST" && url.pathname === INTERNAL_CLAIM_REGISTER_PATH) {
""",
    """    if (request.method === "POST" && url.pathname === INTERNAL_STORAGE_RELEASE_PATH) {
      return this.releaseDestinationStorage(request);
    }
    if (request.method === "POST" && url.pathname === INTERNAL_SETTLEMENT_FAMILY_REGISTER_PATH) {
      return this.registerSettlementFamilyFollow(request);
    }
    if (request.method === "POST" && url.pathname === INTERNAL_CLAIM_REGISTER_PATH) {
""",
)

replace_once(
    "src/autonomy-region.ts",
    """    const activeTravels = await this.resumeAutonomousTravels(state);
    const migrationState = await this.resumeSettlementMigration(state);
    if (migrationState === "handoff") return;

    const directions = autonomyHaloPlanningDirections(state);
    const scoutDue = shouldScoutAutonomyHalo(state);
    const migrationDue = migrationState === undefined && shouldScoutSettlementMigration(state);
    const loadedDirections = (scoutDue && directions.length > 0) || migrationDue
      ? HEX_GRID_DIRECTIONS
      : directions;
""",
    """    await this.notifySettledPioneers(state);
    const activeTravels = await this.resumeAutonomousTravels(state);
    const migrationState = await this.resumeSettlementMigration(state);
    if (migrationState === "handoff") return;

    const directions = autonomyHaloPlanningDirections(state);
    const scoutDue = shouldScoutAutonomyHalo(state);
    const migrationDue = migrationState === undefined && shouldScoutSettlementMigration(state);
    const familyFollowDue = hasSettlementFamilyFollow(state);
    const loadedDirections = (scoutDue && directions.length > 0) || migrationDue || familyFollowDue
      ? HEX_GRID_DIRECTIONS
      : directions;
""",
)

replace_once(
    "src/autonomy-region.ts",
    """    if (loadedDirections.length > 0) {
      halo = await this.materializeAutonomyHalo(state, loadedDirections);
      const claims = await this.activeAutonomousSupplyClaims(state.tick);
""",
    """    if (loadedDirections.length > 0) {
      halo = await this.materializeAutonomyHalo(state, loadedDirections);
      if (familyFollowDue && await this.advanceSettlementFamilyFollow(state, halo)) return;
      const claims = await this.activeAutonomousSupplyClaims(state.tick);
""",
)

# Regression tests cover registration identity, admission gates, monotonic routing,
# external-task authority, and final-target marker clearing through ownership attach.
Path("tests/settlement-family-follow.test.mjs").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import { attachAgentOwnership, globalHandoffAgentId } from "../dist-ts/src/agent-ownership.js";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import {
  hasSettlementFamilyFollow,
  planSettlementFamilyFollow,
  registerSettlementFamilyFollowers,
  settlementFamilyAdmissionReady,
} from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function clearHex(state) {
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
  }
}

function baseAgent(state) {
  const agent = state.agents[0];
  assert.ok(agent);
  return structuredClone(agent);
}

test("settled pioneer registers a bounded partner-caregiver-dependent family group", () => {
  const state = createInitialWorld({ seed: 260916, width: 40, height: 24, regionId: "garden-1" });
  clearHex(state);
  const template = baseAgent(state);
  const pioneerLocalId = "pioneer";
  const pioneerId = globalHandoffAgentId(pioneerLocalId, state.regionId);
  const partner = { ...structuredClone(template), id: "partner", factionId: template.factionId, hp: 100 };
  const child = {
    ...structuredClone(template),
    id: "child",
    factionId: template.factionId,
    hp: 100,
    autonomy: false,
    lifeStage: "infant",
    parents: [pioneerId, partner.id],
    position: { x: 20, y: 11 },
  };
  partner.position = { x: 20, y: 11 };
  const unrelated = { ...structuredClone(template), id: "unrelated", factionId: template.factionId, hp: 100 };
  state.agents = [partner, child, unrelated];

  const result = registerSettlementFamilyFollowers(
    state,
    pioneerId,
    "hex-q1-r0",
    template.factionId,
    globalHandoffAgentId(partner.id, state.regionId),
  );

  assert.deepEqual(new Set(result.agentIds), new Set(["partner", "child"]));
  assert.equal(partner.settlementFamilyTargetRegionId, "hex-q1-r0");
  assert.equal(child.settlementFamilyTargetRegionId, "hex-q1-r0");
  assert.equal(unrelated.settlementFamilyTargetRegionId, undefined);
});

test("family admission requires a camp, storage headroom, and usable food support", () => {
  const state = createInitialWorld({ seed: 260917, width: 40, height: 24, regionId: "hex-q1-r0" });
  clearHex(state);
  const faction = state.factions[0];
  assert.ok(faction);
  state.structures = [{
    id: "frontier-camp",
    factionId: faction.id,
    type: "camp",
    position: { x: 19, y: 11 },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  }];
  faction.resources = { wood: 0, stone: 0, food: 0 };
  assert.equal(settlementFamilyAdmissionReady(state, faction.id), false);
  const foodTile = state.tiles.find((tile) => isHexGridCell(state, tile) && tile.terrain !== "water");
  assert.ok(foodTile);
  foodTile.resource = { kind: "food", amount: 3, maxAmount: 3 };
  assert.equal(settlementFamilyAdmissionReady(state, faction.id), true);
});

test("family follow chooses a neighboring region that strictly approaches the final target", () => {
  const state = createInitialWorld({ seed: 260918, width: 40, height: 24, regionId: "garden-1" });
  clearHex(state);
  const follower = baseAgent(state);
  follower.id = "follower";
  follower.position = { x: 19, y: 11 };
  follower.energy = 100;
  follower.settlementFamilyTargetRegionId = "hex-q2-r0";
  delete follower.task;
  state.agents = [follower];
  const seam = { x: 30, y: 11 };
  const plan = planSettlementFamilyFollow(state, [
    {
      direction: "E",
      sourcePosition: seam,
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 11 },
      tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 },
    },
    {
      direction: "NE",
      sourcePosition: seam,
      neighborRegionId: "hex-q1-r-1",
      neighborPosition: { x: 8, y: 11 },
      tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 },
    },
  ]);
  assert.ok(plan);
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
  assert.equal(plan.targetRegionId, "hex-q2-r0");
  assert.equal(hasSettlementFamilyFollow(state), true);
});

test("external family task remains authoritative", () => {
  const state = createInitialWorld({ seed: 260919, width: 40, height: 24, regionId: "garden-1" });
  clearHex(state);
  const follower = baseAgent(state);
  follower.id = "follower";
  follower.position = { x: 19, y: 11 };
  follower.energy = 100;
  follower.settlementFamilyTargetRegionId = "hex-q1-r0";
  follower.task = {
    source: "external",
    issuedAtTick: state.tick,
    type: "move",
    target: { x: 20, y: 11 },
  };
  state.agents = [follower];
  assert.equal(planSettlementFamilyFollow(state, [{
    direction: "E",
    sourcePosition: { x: 30, y: 11 },
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 },
  }]), undefined);
});

test("ownership attach clears the family target only on final arrival", () => {
  const source = createInitialWorld({ seed: 260920, width: 40, height: 24, regionId: "garden-1" });
  const target = createInitialWorld({ seed: 260921, width: 40, height: 24, regionId: "hex-q1-r0" });
  clearHex(target);
  const moving = baseAgent(source);
  moving.id = "family-follower";
  moving.factionId = target.factions[0].id;
  moving.settlementFamilyTargetRegionId = target.regionId;
  delete moving.task;
  target.agents = target.agents.filter((agent) => agent.id !== globalHandoffAgentId(moving.id, source.regionId));
  const result = attachAgentOwnership(target, [], moving, { x: 19, y: 11 }, source.regionId);
  assert.equal(result.ok, true, result.reason);
  const arrived = result.value?.state.agents.find((agent) => agent.id === globalHandoffAgentId(moving.id, source.regionId));
  assert.ok(arrived);
  assert.equal(arrived.settlementFamilyTargetRegionId, undefined);
});
''')

# Document the new bounded family-follow behavior next to migration support scoring.
support = Path("src/settlement-migration-support.md")
support.write_text(support.read_text() + """

## Bounded family follow after frontier admission

A pioneer no longer causes immediate family members to teleport or follow every scouting hop. The pioneer keeps its existing immutable settlement origin while scouting. Once a target region has an active same-faction camp, positive storage headroom, and either stored food or live local food supply, that target sends an idempotent registration back to the origin region. The origin marks at most six directly related residents (active pregnancy partner, dependent children, their caregiver/co-parent) with only a final region identity.

Marked followers reuse the same depth-1 six-direction halo and crash-safe per-agent ownership handoff. Each hop must strictly reduce axial hex distance to the final region, source-local coordinates are discarded at the seam, and only one existing handoff journal is used at a time. External tasks remain authoritative. Infant/juvenile local caregiver-follow is suspended while this explicit family route marker exists, avoiding two competing autonomous move goals. The marker survives intermediate ownership transfers and is removed only when the follower actually attaches in the final region.

This is intentionally a bounded first stage rather than atomic group transfer: adults/caregivers are prioritized before dependents, the group is capped at six, and temporary separation can exist while serialized handoffs complete. It preserves existing WorldState schemaVersion 1 and does not copy remote Agent snapshots or source-local structure IDs across regions.
""")
