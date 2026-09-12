import {
  materializeHexHalo,
  type HexHaloEdgeSnapshot,
  type HexHaloTile,
} from "./hex-halo.js";
import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  isHexGridCell,
  type HexGridDirection,
} from "./hex-grid.js";
import {
  haloLinksForActivity,
  RegionDurableObject as HaloRegionDurableObject,
  type RegionActivityTier,
} from "./halo-region.js";
import {
  positionKey,
  type Agent,
  type GridPosition,
  type ResourceKind,
  type WorldState,
} from "./protocol.js";
import { regionAxialCoordinate, regionCellTransition } from "./region-topology.js";
import {
  planAutonomousSettlementMigration,
  prepareSettlementMigrationKit,
  shouldScoutSettlementMigration,
  type AutonomousSettlementMigrationPlan,
} from "./settlement-migration.js";
import { WorldRuntime } from "./runtime.js";
import { isPassable } from "./world.js";

interface AutonomyEnv {
  REGIONS: DurableObjectNamespace<RegionDurableObject>;
  ASSETS: Fetcher;
  DEFAULT_REGION_ID?: string;
  REGION_IDS?: string;
  WORLD_SEED?: string;
  TICK_MS?: string;
  OPEN_COMMANDS?: string;
  COMMAND_TOKEN?: string;
  ADMIN_TOKEN?: string;
}

interface RuntimeAccess {
  runtime: WorldRuntime;
}

interface PendingAutonomousHandoff {
  transferId: string;
  agentId: string;
  direction: HexGridDirection;
  resource: ResourceKind | undefined;
  claimId?: string;
  desiredPosition?: GridPosition;
  returnToSourceStorage?: boolean;
  settlementMigration?: boolean;
}

interface PendingAutonomousTravel {
  agentId: string;
  resource: ResourceKind;
  direction: HexGridDirection;
  neighborRegionId: string;
  boundaryTarget: GridPosition;
  issuedAtTick: number;
  startedAtTick: number;
  claimId?: string;
  claimedSupply?: number;
}

export interface AutonomousSupplyClaim {
  claimId: string;
  agentId?: string;
  resource: ResourceKind;
  direction: HexGridDirection;
  neighborRegionId: string;
  amount: number;
  settledAmount?: number;
  expiresAtTick: number;
  returnToSourceStorage?: boolean;
}

interface AutonomousArrivalClaim {
  claimId: string;
  sourceRegionId: string;
  agentId: string;
  resource: ResourceKind;
  registeredAtTick: number;
  gatheredAmount?: number;
  settledAmount?: number;
  returnToSourceStorage?: boolean;
}

export interface AutonomousHaloHandoffPlan extends PendingAutonomousHandoff {
  neighborRegionId: string;
}

export interface AutonomousHaloTravelPlan extends PendingAutonomousTravel {}

const AUTONOMOUS_HANDOFF_KEY = "handoff:autonomy:v1";
const AUTONOMOUS_TRAVEL_KEY = "handoff:autonomy:travel:v1";
const AUTONOMOUS_TRAVELS_KEY = "handoff:autonomy:travel:v2";
const AUTONOMOUS_SUPPLY_CLAIMS_KEY = "handoff:autonomy:claims:v1";
const AUTONOMOUS_ARRIVAL_CLAIMS_KEY = "handoff:autonomy:arrival-claims:v1";
const AUTONOMOUS_SETTLEMENT_MIGRATION_KEY = "handoff:autonomy:settlement-migration:v1";
const INTERNAL_EDGE_PATH = "/api/internal/halo/edge";
const INTERNAL_AUTONOMY_PREFIX = "/api/internal/autonomy/";
const INTERNAL_CLAIM_REGISTER_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/register`;
const INTERNAL_CLAIM_SETTLE_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/settle`;
const INTERNAL_CLAIM_RELEASE_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/release`;
const LOW_ENERGY_THRESHOLD = 18;
const AUTONOMOUS_SCOUT_INTERVAL = 12;
const AUTONOMOUS_TRAVEL_TTL = 48;
const AUTONOMOUS_SUPPLY_CLAIM_TTL = AUTONOMOUS_TRAVEL_TTL + AUTONOMOUS_SCOUT_INTERVAL;
const MAX_CONCURRENT_AUTONOMOUS_TRAVELS = 3;
const SETTLEMENT_MIGRATION_TTL = 72;
// Successful bounded catch-up batches can drain debt promptly without
// putting dozens of full virtual ticks into one DO invocation. Failed
// batches keep the normal tick retry to avoid a hot failure loop.
const CATCH_UP_RETRY_MS = 1_000;

function runtimeAccess(instance: RegionDurableObject): RuntimeAccess {
  return instance as unknown as RuntimeAccess;
}

function configuredRegionIds(env: AutonomyEnv): string[] {
  const configured = env.REGION_IDS ?? env.DEFAULT_REGION_ID ?? "garden-1";
  const regions = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(entry));
  return regions.length > 0 ? [...new Set(regions)] : ["garden-1"];
}

export function autonomyHaloLinksForActivity(
  extent: Pick<WorldState, "width" | "height">,
  regionIds: readonly string[],
  sourceRegionId: string,
  tier: RegionActivityTier,
) {
  return haloLinksForActivity(extent, regionIds, sourceRegionId, tier);
}

export function autonomyHaloLinks(
  extent: Pick<WorldState, "width" | "height">,
  regionIds: readonly string[],
  sourceRegionId: string,
) {
  return autonomyHaloLinksForActivity(extent, regionIds, sourceRegionId, "warm");
}

export function isAutonomyClaimSourceRegionId(
  regionIds: readonly string[],
  sourceRegionId: string,
): boolean {
  return regionIds.includes(sourceRegionId) || regionAxialCoordinate(sourceRegionId) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEdgeSnapshot(value: unknown): value is HexHaloEdgeSnapshot {
  return isRecord(value)
    && typeof value.regionId === "string"
    && typeof value.direction === "string"
    && Number.isInteger(value.revision)
    && Number.isInteger(value.tick)
    && Array.isArray(value.tiles);
}

function isResourceKind(value: unknown): value is ResourceKind {
  return value === "wood" || value === "stone" || value === "food";
}

function isPendingAutonomousTravel(value: unknown): value is PendingAutonomousTravel {
  return isRecord(value)
    && typeof value.agentId === "string"
    && isResourceKind(value.resource)
    && typeof value.direction === "string"
    && HEX_GRID_DIRECTIONS.includes(value.direction as HexGridDirection)
    && typeof value.neighborRegionId === "string"
    && isRecord(value.boundaryTarget)
    && Number.isInteger(value.boundaryTarget.x)
    && Number.isInteger(value.boundaryTarget.y)
    && Number.isInteger(value.issuedAtTick)
    && Number.isInteger(value.startedAtTick)
    && (value.claimId === undefined || typeof value.claimId === "string")
    && (value.claimedSupply === undefined || (
      typeof value.claimedSupply === "number"
      && Number.isFinite(value.claimedSupply)
      && value.claimedSupply >= 0
    ));
}

function isAutonomousSupplyClaim(value: unknown): value is AutonomousSupplyClaim {
  return isRecord(value)
    && typeof value.claimId === "string"
    && (value.agentId === undefined || typeof value.agentId === "string")
    && isResourceKind(value.resource)
    && typeof value.direction === "string"
    && HEX_GRID_DIRECTIONS.includes(value.direction as HexGridDirection)
    && typeof value.neighborRegionId === "string"
    && typeof value.amount === "number"
    && Number.isFinite(value.amount)
    && value.amount > 0
    && (value.settledAmount === undefined || (
      typeof value.settledAmount === "number"
      && Number.isFinite(value.settledAmount)
      && value.settledAmount >= 0
    ))
    && typeof value.expiresAtTick === "number"
    && Number.isInteger(value.expiresAtTick)
    && (value.returnToSourceStorage === undefined || typeof value.returnToSourceStorage === "boolean");
}

function isAutonomousArrivalClaim(value: unknown): value is AutonomousArrivalClaim {
  return isRecord(value)
    && typeof value.claimId === "string"
    && typeof value.sourceRegionId === "string"
    && typeof value.agentId === "string"
    && isResourceKind(value.resource)
    && Number.isInteger(value.registeredAtTick)
    && (value.gatheredAmount === undefined || (
      typeof value.gatheredAmount === "number"
      && Number.isFinite(value.gatheredAmount)
      && value.gatheredAmount >= 0
    ))
    && (value.settledAmount === undefined || (
      typeof value.settledAmount === "number"
      && Number.isFinite(value.settledAmount)
      && value.settledAmount >= 0
    ))
    && (value.returnToSourceStorage === undefined || typeof value.returnToSourceStorage === "boolean");
}

function inventoryAmount(agent: Agent): number {
  return agent.inventory.wood + agent.inventory.stone + agent.inventory.food;
}

function hasActiveFactionStructure(state: WorldState, factionId: string): boolean {
  return state.structures.some((structure) =>
    structure.factionId === factionId && structure.status === "active"
  );
}

function resourceIntent(state: WorldState, agent: Agent): ResourceKind | undefined {
  // Existing gather tasks must obey the same safety gates as idle workers.
  if (agent.energy <= LOW_ENERGY_THRESHOLD || remainingInventoryCapacity(agent) <= 0) return undefined;
  if (agent.task !== undefined) {
    return agent.task.source === "autonomy" && agent.task.type === "gather"
      ? agent.task.resource
      : undefined;
  }
  if (
    hasActiveFactionStructure(state, agent.factionId) &&
    inventoryAmount(agent) >= Math.min(6, agent.capacity)
  ) {
    return undefined;
  }
  if (agent.role === "woodcutter") return "wood";
  if (agent.role === "miner") return "stone";
  if (agent.role === "forager") return "food";
  return undefined;
}

function localResourceAvailable(state: WorldState, resource: ResourceKind): boolean {
  return state.tiles.some((tile) =>
    tile.terrain !== "water" &&
    tile.resource?.kind === resource &&
    tile.resource.amount > 0
  );
}

function boundaryDirections(
  state: WorldState,
  position: Agent["position"],
): HexGridDirection[] {
  if (!isHexGridCell(state, position)) return [];
  return HEX_GRID_DIRECTIONS.filter((direction) => {
    const step = HEX_GRID_DIRECTION_STEPS[direction];
    return !isHexGridCell(state, {
      x: position.x + step.x,
      y: position.y + step.y,
    });
  });
}

function isBoundaryPosition(state: WorldState, position: Agent["position"]): boolean {
  return boundaryDirections(state, position).length > 0;
}

function returnHandoffForArrival(
  state: WorldState,
  agent: Agent,
  claim: AutonomousArrivalClaim,
): PendingAutonomousHandoff | undefined {
  if (
    claim.returnToSourceStorage !== true ||
    inventoryAmount(agent) <= 0 ||
    hasActiveFactionStructure(state, agent.factionId)
  ) return undefined;

  for (const direction of boundaryDirections(state, agent.position)) {
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
    if (transition?.targetRegionId !== claim.sourceRegionId) continue;
    return {
      transferId: `return:${state.regionId}:${agent.id}:${state.tick}:${direction}`,
      agentId: agent.id,
      direction,
      resource: claim.resource,
      desiredPosition,
    };
  }
  return undefined;
}

function returnTravelTargetForArrival(
  state: WorldState,
  agent: Agent,
  claim: AutonomousArrivalClaim,
): GridPosition | undefined {
  if (
    claim.returnToSourceStorage !== true ||
    inventoryAmount(agent) <= 0 ||
    hasActiveFactionStructure(state, agent.factionId)
  ) return undefined;

  const distances = localPathDistances(state, agent.position);
  const candidates: Array<{ position: GridPosition; distance: number; direction: HexGridDirection }> = [];
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
      if (transition?.targetRegionId !== claim.sourceRegionId) continue;
      candidates.push({ position, distance, direction });
    }
  }
  return candidates
    .sort((a, b) =>
      a.distance - b.distance ||
      directionRank(a.direction) - directionRank(b.direction) ||
      a.position.y - b.position.y ||
      a.position.x - b.position.x
    )[0]?.position;
}

function samePosition(
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  return a.x === b.x && a.y === b.y;
}

function directionRank(direction: HexGridDirection): number {
  return HEX_GRID_DIRECTIONS.indexOf(direction);
}

function localPathDistances(state: WorldState, start: GridPosition): Map<string, number> {
  const distances = new Map<string, number>([[positionKey(start), 0]]);
  const queue: GridPosition[] = [{ ...start }];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) break;
    const currentDistance = distances.get(positionKey(current)) ?? 0;
    for (const direction of HEX_GRID_DIRECTIONS) {
      const step = HEX_GRID_DIRECTION_STEPS[direction];
      const next = { x: current.x + step.x, y: current.y + step.y };
      const key = positionKey(next);
      if (distances.has(key) || !isPassable(state, next)) continue;
      distances.set(key, currentDistance + 1);
      queue.push(next);
    }
  }

  return distances;
}

function remainingInventoryCapacity(agent: Agent): number {
  return Math.max(0, agent.capacity - inventoryAmount(agent));
}

function haloSupplyKey(neighborRegionId: string): string {
  return neighborRegionId;
}

function haloSupplyCellKey(entry: Pick<HexHaloTile, "neighborRegionId" | "neighborPosition">): string {
  return `${entry.neighborRegionId}:${entry.neighborPosition.x},${entry.neighborPosition.y}`;
}

function availableHaloSupplyForAgent(
  state: Pick<WorldState, "tick">,
  halo: readonly HexHaloTile[],
  claims: readonly AutonomousSupplyClaim[],
  agentId: string,
  resource: ResourceKind,
  neighborRegionId: string,
): number {
  let visibleSupply = 0;
  const seenCells = new Set<string>();
  for (const entry of halo) {
    if (
      entry.neighborRegionId !== neighborRegionId ||
      entry.tile.terrain === "water" ||
      entry.tile.resource?.kind !== resource ||
      entry.tile.resource.amount <= 0
    ) {
      continue;
    }
    const cellKey = haloSupplyCellKey(entry);
    if (seenCells.has(cellKey)) continue;
    seenCells.add(cellKey);
    visibleSupply += entry.tile.resource.amount;
  }

  let claimedSupply = 0;
  for (const claim of claims) {
    if (
      claim.resource !== resource ||
      claim.neighborRegionId !== neighborRegionId ||
      claim.expiresAtTick <= state.tick ||
      claim.agentId === agentId
    ) {
      continue;
    }
    claimedSupply += claim.amount;
  }
  return Math.max(0, visibleSupply - claimedSupply);
}

function isMatchingTravelTask(agent: Agent, pending: PendingAutonomousTravel): boolean {
  return agent.task?.source === "autonomy"
    && agent.task.type === "move"
    && samePosition(agent.task.target, pending.boundaryTarget);
}

export function autonomyHaloPlanningDirections(state: WorldState): HexGridDirection[] {
  const needed = new Set<HexGridDirection>();
  for (const agent of state.agents) {
    if (!agent.autonomy) continue;
    const resource = resourceIntent(state, agent);
    if (resource === undefined || localResourceAvailable(state, resource)) continue;
    for (const direction of boundaryDirections(state, agent.position)) needed.add(direction);
  }
  return HEX_GRID_DIRECTIONS.filter((direction) => needed.has(direction));
}

export function shouldScoutAutonomyHalo(state: WorldState): boolean {
  if (state.tick % AUTONOMOUS_SCOUT_INTERVAL !== 0) return false;
  return state.agents.some((agent) => {
    if (!agent.autonomy || isBoundaryPosition(state, agent.position)) return false;
    const resource = resourceIntent(state, agent);
    return resource !== undefined && !localResourceAvailable(state, resource);
  });
}

export function planAutonomousHaloTravel(
  state: WorldState,
  halo: readonly HexHaloTile[],
  claims: readonly AutonomousSupplyClaim[] = [],
): AutonomousHaloTravelPlan | undefined {
  const expeditions: Array<{
    agent: Agent;
    resource: ResourceKind;
    candidate: HexHaloTile;
    visibleSupply: number;
    travelDistance: number;
    costPerUnit: number;
  }> = [];

  for (const agent of state.agents) {
    if (!agent.autonomy || isBoundaryPosition(state, agent.position)) continue;
    const resource = resourceIntent(state, agent);
    if (resource === undefined || localResourceAvailable(state, resource)) continue;

    const capacityLeft = remainingInventoryCapacity(agent);
    if (capacityLeft <= 0) continue;
    const travelEnergyBudget = Math.max(0, agent.energy - LOW_ENERGY_THRESHOLD);
    const pathDistances = localPathDistances(state, agent.position);
    const candidates = halo.flatMap((entry) => {
      const travelDistance = pathDistances.get(positionKey(entry.sourcePosition));
      if (
        travelDistance === undefined ||
        travelDistance > travelEnergyBudget ||
        entry.tile.terrain === "water" ||
        entry.tile.resource?.kind !== resource ||
        entry.tile.resource.amount <= 0
      ) {
        return [];
      }
      return [{ entry, travelDistance }];
    });
    // Exact hex ownership can expose the same neighboring cell through two
    // outward source directions along a slanted seam. Count physical supply
    // once per target cell and reserve it once per owning region so a second
    // route cannot double-book the same deposit.
    const visibleSupply = new Map<string, number>();
    const visibleCells = new Set<string>();
    for (const { entry } of candidates) {
      const cellKey = haloSupplyCellKey(entry);
      if (visibleCells.has(cellKey)) continue;
      visibleCells.add(cellKey);
      const key = haloSupplyKey(entry.neighborRegionId);
      visibleSupply.set(key, (visibleSupply.get(key) ?? 0) + (entry.tile.resource?.amount ?? 0));
    }
    const claimedSupply = new Map<string, number>();
    for (const claim of claims) {
      if (claim.resource !== resource || claim.expiresAtTick <= state.tick) continue;
      const key = haloSupplyKey(claim.neighborRegionId);
      claimedSupply.set(key, (claimedSupply.get(key) ?? 0) + claim.amount);
    }

    const candidate = candidates
      .flatMap(({ entry, travelDistance }) => {
        const key = haloSupplyKey(entry.neighborRegionId);
        const availableSupply = Math.max(
          0,
          (visibleSupply.get(key) ?? 0) - (claimedSupply.get(key) ?? 0),
        );
        const supply = Math.min(capacityLeft, availableSupply);
        if (supply <= 0) return [];
        return [{
          entry,
          travelDistance,
          visibleSupply: supply,
          costPerUnit: travelDistance / supply,
        }];
      })
      .sort((a, b) =>
        a.costPerUnit - b.costPerUnit
        || b.visibleSupply - a.visibleSupply
        || a.travelDistance - b.travelDistance
        || directionRank(a.entry.direction) - directionRank(b.entry.direction)
        || a.entry.neighborRegionId.localeCompare(b.entry.neighborRegionId)
        || a.entry.sourcePosition.y - b.entry.sourcePosition.y
        || a.entry.sourcePosition.x - b.entry.sourcePosition.x
      )[0];
    if (candidate === undefined) continue;

    expeditions.push({
      agent,
      resource,
      candidate: candidate.entry,
      visibleSupply: candidate.visibleSupply,
      travelDistance: candidate.travelDistance,
      costPerUnit: candidate.costPerUnit,
    });
  }

  const expedition = expeditions.sort((a, b) =>
    a.costPerUnit - b.costPerUnit
    || b.visibleSupply - a.visibleSupply
    || a.travelDistance - b.travelDistance
    || a.agent.id.localeCompare(b.agent.id)
    || directionRank(a.candidate.direction) - directionRank(b.candidate.direction)
    || a.candidate.neighborRegionId.localeCompare(b.candidate.neighborRegionId)
    || a.candidate.sourcePosition.y - b.candidate.sourcePosition.y
    || a.candidate.sourcePosition.x - b.candidate.sourcePosition.x
  )[0];
  if (expedition === undefined) return undefined;

  const issuedAtTick = expedition.agent.task?.source === "autonomy" && expedition.agent.task.type === "gather"
    ? expedition.agent.task.issuedAtTick
    : state.tick;
  return {
    agentId: expedition.agent.id,
    resource: expedition.resource,
    direction: expedition.candidate.direction,
    neighborRegionId: expedition.candidate.neighborRegionId,
    boundaryTarget: { ...expedition.candidate.sourcePosition },
    issuedAtTick,
    startedAtTick: state.tick,
    claimedSupply: expedition.visibleSupply,
  };
}

export function planAutonomousHaloHandoff(
  state: WorldState,
  halo: readonly HexHaloTile[],
  claims: readonly AutonomousSupplyClaim[] = [],
): AutonomousHaloHandoffPlan | undefined {
  const agents = [...state.agents].sort((a, b) => a.id.localeCompare(b.id));
  for (const agent of agents) {
    if (!agent.autonomy) continue;
    const resource = resourceIntent(state, agent);
    if (resource === undefined || localResourceAvailable(state, resource)) continue;
    if (!isBoundaryPosition(state, agent.position)) continue;

    const candidate = halo
      .filter((entry) =>
        samePosition(entry.sourcePosition, agent.position) &&
        entry.tile.terrain !== "water" &&
        entry.tile.resource?.kind === resource &&
        entry.tile.resource.amount > 0 &&
        availableHaloSupplyForAgent(
          state,
          halo,
          claims,
          agent.id,
          resource,
          entry.neighborRegionId,
        ) > 0
      )
      .map((entry) => ({
        entry,
        claim: claims
          .filter((claim) =>
            claim.agentId === agent.id &&
            claim.resource === resource &&
            claim.direction === entry.direction &&
            claim.neighborRegionId === entry.neighborRegionId &&
            claim.expiresAtTick > state.tick
          )
          .sort((a, b) =>
            b.expiresAtTick - a.expiresAtTick || b.claimId.localeCompare(a.claimId)
          )[0],
      }))
      .sort((a, b) =>
        Number(b.claim !== undefined) - Number(a.claim !== undefined) ||
        (b.claim?.expiresAtTick ?? -1) - (a.claim?.expiresAtTick ?? -1) ||
        directionRank(a.entry.direction) - directionRank(b.entry.direction) ||
        a.entry.neighborRegionId.localeCompare(b.entry.neighborRegionId)
      )[0];
    if (candidate === undefined) continue;

    // Interior travel already selected and reserved a concrete neighboring
    // supply. At a multi-exit corner, keep that reservation authoritative
    // instead of drifting to the first direction in the static direction list.
    const issuedAtTick = agent.task?.source === "autonomy" && agent.task.type === "gather"
      ? agent.task.issuedAtTick
      : state.tick;
    const claimId = candidate.claim?.claimId;
    return {
      transferId: `autonomy:${state.regionId}:${agent.id}:${issuedAtTick}:${candidate.entry.direction}`,
      agentId: agent.id,
      direction: candidate.entry.direction,
      resource,
      neighborRegionId: candidate.entry.neighborRegionId,
      desiredPosition: {
        x: candidate.entry.sourcePosition.x + HEX_GRID_DIRECTION_STEPS[candidate.entry.direction].x,
        y: candidate.entry.sourcePosition.y + HEX_GRID_DIRECTION_STEPS[candidate.entry.direction].y,
      },
      ...(claimId === undefined ? {} : { claimId }),
      ...(candidate.claim?.returnToSourceStorage === true ? { returnToSourceStorage: true } : {}),
    };
  }
  return undefined;
}

export class RegionDurableObject extends HaloRegionDurableObject {
  constructor(
    private readonly autonomyState: DurableObjectState,
    private readonly autonomyEnv: AutonomyEnv,
  ) {
    super(autonomyState, autonomyEnv);
  }

  private autonomyStub(regionId: string): DurableObjectStub {
    const stub = this.autonomyEnv.REGIONS.get(this.autonomyEnv.REGIONS.idFromName(regionId));
    return {
      fetch: (input, init) => {
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        return ["GET", "HEAD", "OPTIONS"].includes(method)
          ? stub.fetch(input, init)
          : this.withHaloEdgeMutation(() => stub.fetch(input, init));
      },
    };
  }

  private async materializeAutonomyHalo(
    state: WorldState,
    directions: readonly HexGridDirection[],
  ): Promise<HexHaloTile[]> {
    const needed = new Set(directions);
    const links = autonomyHaloLinksForActivity(
      state,
      configuredRegionIds(this.autonomyEnv),
      state.regionId,
      this.activityTier(),
    ).filter((link) => needed.has(link.direction));
    const requested = new Map<string, { regionId: string; direction: HexGridDirection }>();
    for (const link of links) {
      const direction = link.neighborDirection;
      requested.set(`${link.neighborRegionId}:${direction}`, {
        regionId: link.neighborRegionId,
        direction,
      });
    }
    const edges = (
      await Promise.all(
        [...requested.values()].map(({ regionId, direction }) =>
          this.fetchNeighborEdge(regionId, direction)
        ),
      )
    ).filter((value): value is HexHaloEdgeSnapshot => value !== undefined);
    return materializeHexHalo(links, edges);
  }

  private async activeAutonomousSupplyClaims(tick: number): Promise<AutonomousSupplyClaim[]> {
    const stored = await this.autonomyState.storage.get<unknown>(AUTONOMOUS_SUPPLY_CLAIMS_KEY);
    const valid = Array.isArray(stored)
      ? stored.filter(isAutonomousSupplyClaim)
      : [];
    const active = valid.filter((claim) => claim.expiresAtTick > tick);
    if (!Array.isArray(stored) || active.length !== stored.length) {
      await this.autonomyState.storage.put(AUTONOMOUS_SUPPLY_CLAIMS_KEY, active);
    }
    return active;
  }

  private async releaseAutonomousSupplyClaim(claimId: string | undefined): Promise<void> {
    if (claimId === undefined) return;
    const stored = await this.autonomyState.storage.get<unknown>(AUTONOMOUS_SUPPLY_CLAIMS_KEY);
    if (!Array.isArray(stored)) return;
    const next = stored
      .filter(isAutonomousSupplyClaim)
      .filter((claim) => claim.claimId !== claimId);
    if (next.length !== stored.length) {
      await this.autonomyState.storage.put(AUTONOMOUS_SUPPLY_CLAIMS_KEY, next);
    }
  }

  private async arrivalClaims(): Promise<AutonomousArrivalClaim[]> {
    const stored = await this.autonomyState.storage.get<unknown>(AUTONOMOUS_ARRIVAL_CLAIMS_KEY);
    if (stored === undefined) return [];
    const valid = Array.isArray(stored)
      ? stored.filter(isAutonomousArrivalClaim)
      : [];
    if (!Array.isArray(stored) || valid.length !== stored.length) {
      await this.autonomyState.storage.put(AUTONOMOUS_ARRIVAL_CLAIMS_KEY, valid);
    }
    return valid;
  }

  private async ensureAutonomyAssigned(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    url.pathname = "/api/health";
    url.search = "";
    const response = await super.fetch(new Request(url, {
      method: "GET",
      headers: request.headers,
    }));
    return response.ok ? undefined : response;
  }

  private async registerArrivalClaim(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "request body must be valid JSON" }), { status: 400 });
    }
    if (
      !isRecord(body) ||
      typeof body.claimId !== "string" ||
      body.claimId.trim() === "" ||
      typeof body.sourceRegionId !== "string" ||
      !isAutonomyClaimSourceRegionId(configuredRegionIds(this.autonomyEnv), body.sourceRegionId) ||
      typeof body.agentId !== "string" ||
      body.agentId.trim() === "" ||
      !isResourceKind(body.resource) ||
      (body.returnToSourceStorage !== undefined && typeof body.returnToSourceStorage !== "boolean")
    ) {
      return new Response(JSON.stringify({ error: "invalid arrival claim" }), { status: 400 });
    }
    const state = runtimeAccess(this).runtime.snapshot();
    const arrived = state.agents.find((entry) => entry.id === body.agentId);
    if (
      arrived?.autonomy !== true ||
      arrived.task?.source !== "autonomy" ||
      arrived.task.type !== "gather" ||
      arrived.task.resource !== body.resource
    ) {
      return new Response(JSON.stringify({ error: "arrival agent is not continuing this gather intent" }), {
        status: 409,
      });
    }
    const claims = await this.arrivalClaims();
    const existing = claims.find((entry) => entry.claimId === body.claimId);
    const claim: AutonomousArrivalClaim = {
      claimId: body.claimId,
      sourceRegionId: body.sourceRegionId,
      agentId: body.agentId,
      resource: body.resource,
      registeredAtTick: existing?.registeredAtTick ?? state.tick,
      gatheredAmount: existing?.gatheredAmount ?? 0,
      settledAmount: existing?.settledAmount ?? 0,
      returnToSourceStorage: existing?.returnToSourceStorage ?? body.returnToSourceStorage === true,
    };
    await this.autonomyState.storage.put(
      AUTONOMOUS_ARRIVAL_CLAIMS_KEY,
      [...claims.filter((entry) => entry.claimId !== claim.claimId), claim],
    );
    return new Response(JSON.stringify({ ok: true, claimId: claim.claimId }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  private async settleArrivalSourceClaim(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "request body must be valid JSON" }), { status: 400 });
    }
    if (
      !isRecord(body) ||
      typeof body.claimId !== "string" ||
      body.claimId.trim() === "" ||
      typeof body.settledAmount !== "number" ||
      !Number.isFinite(body.settledAmount) ||
      body.settledAmount < 0
    ) {
      return new Response(JSON.stringify({ error: "claimId and non-negative settledAmount are required" }), {
        status: 400,
      });
    }

    const tick = runtimeAccess(this).runtime.snapshot().tick;
    const claims = await this.activeAutonomousSupplyClaims(tick);
    const claim = claims.find((entry) => entry.claimId === body.claimId);
    if (claim === undefined) {
      return new Response(JSON.stringify({
        ok: true,
        claimId: body.claimId,
        settledAmount: body.settledAmount,
        remainingAmount: 0,
      }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const previousSettled = claim.settledAmount ?? 0;
    const settledAmount = Math.max(previousSettled, body.settledAmount);
    const newlySettled = Math.max(0, settledAmount - previousSettled);
    const remainingAmount = Math.max(0, claim.amount - newlySettled);
    const next = remainingAmount > 0
      ? claims.map((entry) => entry.claimId === claim.claimId
        ? { ...entry, amount: remainingAmount, settledAmount }
        : entry)
      : claims.filter((entry) => entry.claimId !== claim.claimId);
    await this.autonomyState.storage.put(AUTONOMOUS_SUPPLY_CLAIMS_KEY, next);
    return new Response(JSON.stringify({
      ok: true,
      claimId: claim.claimId,
      settledAmount,
      remainingAmount,
    }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  private async releaseArrivalSourceClaim(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "request body must be valid JSON" }), { status: 400 });
    }
    if (!isRecord(body) || typeof body.claimId !== "string") {
      return new Response(JSON.stringify({ error: "claimId is required" }), { status: 400 });
    }
    await this.releaseAutonomousSupplyClaim(body.claimId);
    return new Response(JSON.stringify({ ok: true, claimId: body.claimId }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  private async registerSuccessfulArrivalClaim(
    pending: PendingAutonomousHandoff,
    response: Response,
  ): Promise<void> {
    if (pending.claimId === undefined) return;
    let payload: unknown;
    try {
      payload = await response.clone().json();
    } catch {
      return;
    }
    if (
      !isRecord(payload) ||
      typeof payload.toRegionId !== "string" ||
      typeof payload.agentId !== "string"
    ) {
      return;
    }
    const sourceRegionId = runtimeAccess(this).runtime.snapshot().regionId;
    const target = this.autonomyStub(payload.toRegionId);
    try {
      await target.fetch(new Request(`https://moyo.internal${INTERNAL_CLAIM_REGISTER_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-moyo-region-internal": payload.toRegionId,
        },
        body: JSON.stringify({
          claimId: pending.claimId,
          sourceRegionId,
          agentId: payload.agentId,
          resource: pending.resource,
          ...(pending.returnToSourceStorage === true ? { returnToSourceStorage: true } : {}),
        }),
      }));
    } catch {
      // The source-side TTL remains the crash-safe fallback if arrival tracking
      // cannot be installed after the ownership handoff has already committed.
    }
  }

  private async reconcileArrivalClaims(before: WorldState, after: WorldState): Promise<void> {
    const claims = await this.arrivalClaims();
    if (claims.length === 0) return;
    const keep: AutonomousArrivalClaim[] = [];
    let dirty = false;
    for (const claim of claims) {
      const beforeAgent = before.agents.find((entry) => entry.id === claim.agentId);
      const agent = after.agents.find((entry) => entry.id === claim.agentId);
      const wasGathering =
        beforeAgent?.autonomy === true &&
        beforeAgent.task?.source === "autonomy" &&
        beforeAgent.task.type === "gather" &&
        beforeAgent.task.resource === claim.resource;
      const gatheredThisTick = wasGathering && agent !== undefined
        ? Math.max(0, agent.inventory[claim.resource] - beforeAgent.inventory[claim.resource])
        : 0;
      const gatheredAmount = (claim.gatheredAmount ?? 0) + gatheredThisTick;
      let settledAmount = Math.min(claim.settledAmount ?? 0, gatheredAmount);
      let reservationExhausted = false;
      if (gatheredThisTick > 0) dirty = true;

      if (gatheredAmount > settledAmount) {
        try {
          const response = await this.autonomyStub(claim.sourceRegionId).fetch(new Request(
            `https://moyo.internal${INTERNAL_CLAIM_SETTLE_PATH}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-moyo-region-internal": claim.sourceRegionId,
              },
              body: JSON.stringify({ claimId: claim.claimId, settledAmount: gatheredAmount }),
            },
          ));
          if (response.ok) {
            settledAmount = gatheredAmount;
            dirty = true;
            try {
              const payload = await response.json() as unknown;
              reservationExhausted =
                isRecord(payload) &&
                typeof payload.remainingAmount === "number" &&
                payload.remainingAmount <= 0;
            } catch {
              // A successful settlement without a parseable body is still
              // confirmed; final release remains the conservative fallback.
            }
          }
        } catch {
          // Preserve the cumulative observed amount and retry idempotently on
          // the next Alarm if the source DO was temporarily unavailable.
        }
      }

      const updatedClaim: AutonomousArrivalClaim = {
        ...claim,
        gatheredAmount,
        settledAmount,
      };
      const stillGathering =
        agent?.autonomy === true &&
        agent.task?.source === "autonomy" &&
        agent.task.type === "gather" &&
        agent.task.resource === claim.resource;

      if (!stillGathering && agent?.autonomy === true && agent.task?.source !== "external") {
        if (
          updatedClaim.returnToSourceStorage === true &&
          !reservationExhausted &&
          remainingInventoryCapacity(agent) > 0 &&
          localResourceAvailable(after, updatedClaim.resource)
        ) {
          agent.task = {
            source: "autonomy",
            issuedAtTick: after.tick,
            type: "gather",
            resource: updatedClaim.resource,
          };
          agent.status = `continuing ${updatedClaim.resource} expedition`;
          keep.push(updatedClaim);
          this.replaceRuntimeState(after);
          dirty = true;
          continue;
        }
        const pendingReturn = returnHandoffForArrival(after, agent, updatedClaim);
        const existingHandoff = await this.autonomyState.storage.get<PendingAutonomousHandoff | null>(
          AUTONOMOUS_HANDOFF_KEY,
        );
        if (pendingReturn !== undefined && (existingHandoff === undefined || existingHandoff === null)) {
          agent.task = {
            source: "autonomy",
            issuedAtTick: after.tick,
            type: "deposit",
          };
          agent.status = `returning to ${claim.sourceRegionId} with gathered cargo`;
          await this.autonomyState.storage.put(AUTONOMOUS_HANDOFF_KEY, pendingReturn);
          this.replaceRuntimeState(after);
          dirty = true;
          continue;
        }

        if (pendingReturn === undefined && (existingHandoff === undefined || existingHandoff === null)) {
          const returnTarget = returnTravelTargetForArrival(after, agent, updatedClaim);
          if (returnTarget !== undefined && !samePosition(agent.position, returnTarget)) {
            agent.task = {
              source: "autonomy",
              issuedAtTick: after.tick,
              type: "move",
              target: { ...returnTarget },
            };
            agent.status = `traveling back toward ${claim.sourceRegionId} with gathered cargo`;
            keep.push(updatedClaim);
            this.replaceRuntimeState(after);
            dirty = true;
            continue;
          }
        }
      }

      if (reservationExhausted) {
        dirty = true;
        continue;
      }
      if (stillGathering) {
        keep.push(updatedClaim);
        continue;
      }

      try {
        const response = await this.autonomyStub(claim.sourceRegionId).fetch(new Request(
          `https://moyo.internal${INTERNAL_CLAIM_RELEASE_PATH}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-moyo-region-internal": claim.sourceRegionId,
            },
            body: JSON.stringify({ claimId: claim.claimId }),
          },
        ));
        if (!response.ok) keep.push(updatedClaim);
      } catch {
        keep.push(updatedClaim);
      }
    }
    if (dirty || keep.length !== claims.length) {
      await this.autonomyState.storage.put(AUTONOMOUS_ARRIVAL_CLAIMS_KEY, keep);
    }
  }

  private replaceRuntimeState(state: WorldState): void {
    const access = runtimeAccess(this);
    access.runtime = new WorldRuntime({
      state,
      pendingCommands: access.runtime.pendingCommands(),
    });
  }

  private autonomousHandoffRequest(pending: PendingAutonomousHandoff): Request {
    const regionId = runtimeAccess(this).runtime.snapshot().regionId;
    return new Request("http://localhost/api/admin/handoff", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-moyo-region-internal": regionId,
      },
      body: JSON.stringify({
        transferId: pending.transferId,
        agentId: pending.agentId,
        direction: pending.direction,
        ...(pending.desiredPosition === undefined
          ? {}
          : { desiredPosition: { ...pending.desiredPosition } }),
      }),
    });
  }

  private async attemptPendingHandoff(pending: PendingAutonomousHandoff): Promise<void> {
    const response = await super.fetch(this.autonomousHandoffRequest(pending));
    if (response.ok) {
      await this.registerSuccessfulArrivalClaim(pending, response);
      await this.autonomyState.storage.put(AUTONOMOUS_HANDOFF_KEY, null);
      return;
    }
    if (response.status >= 500) return;

    // A 4xx response is already treated as terminal for this handoff. Release
    // the matching short-lived supply reservation as well, otherwise one bad
    // seam can keep healthy agents from using still-visible neighbor supply
    // until the full claim TTL expires. Clear the failed autonomous gather
    // intent so the normal simulation can replan instead of hammering the same
    // terminal handoff every alarm.
    await this.releaseAutonomousSupplyClaim(pending.claimId);
    const state = runtimeAccess(this).runtime.snapshot();
    const agent = state.agents.find((entry) => entry.id === pending.agentId);
    const failedResourceHandoff =
      pending.resource !== undefined &&
      agent?.task?.source === "autonomy" &&
      agent.task.type === "gather" &&
      agent.task.resource === pending.resource;
    const failedSettlementMigration =
      pending.settlementMigration === true &&
      agent?.task?.source === "autonomy" &&
      agent.task.type === "move";
    if (failedResourceHandoff || failedSettlementMigration) {
      delete agent.task;
      agent.status = `handoff ${pending.direction} rejected; replanning`;
      this.replaceRuntimeState(state);
    }
    await this.autonomyState.storage.put(AUTONOMOUS_HANDOFF_KEY, null);
  }

  private async autonomousTravels(): Promise<PendingAutonomousTravel[]> {
    const stored = await this.autonomyState.storage.get<unknown>(AUTONOMOUS_TRAVELS_KEY);
    const travels = Array.isArray(stored)
      ? stored.filter(isPendingAutonomousTravel)
      : [];
    const legacy = await this.autonomyState.storage.get<unknown>(AUTONOMOUS_TRAVEL_KEY);
    let dirty = !Array.isArray(stored) && stored !== undefined;

    if (isPendingAutonomousTravel(legacy)) {
      const duplicate = travels.some((entry) =>
        entry.agentId === legacy.agentId
        || (entry.claimId !== undefined && entry.claimId === legacy.claimId)
      );
      if (!duplicate) travels.push(legacy);
      await this.autonomyState.storage.put(AUTONOMOUS_TRAVEL_KEY, null);
      dirty = true;
    } else if (legacy !== undefined && legacy !== null) {
      await this.autonomyState.storage.put(AUTONOMOUS_TRAVEL_KEY, null);
    }

    if (dirty || (Array.isArray(stored) && travels.length !== stored.length)) {
      await this.autonomyState.storage.put(AUTONOMOUS_TRAVELS_KEY, travels);
    }
    return travels;
  }

  private async resumeAutonomousTravels(state: WorldState): Promise<number> {
    const travels = await this.autonomousTravels();
    if (travels.length === 0) return 0;

    const keep: PendingAutonomousTravel[] = [];
    let stateDirty = false;
    for (const pending of travels) {
      const agent = state.agents.find((entry) => entry.id === pending.agentId);
      if (agent === undefined || !agent.autonomy || agent.task?.source === "external") {
        await this.releaseAutonomousSupplyClaim(pending.claimId);
        continue;
      }

      if (
        agent.energy <= LOW_ENERGY_THRESHOLD ||
        remainingInventoryCapacity(agent) <= 0 ||
        localResourceAvailable(state, pending.resource) ||
        state.tick - pending.startedAtTick > AUTONOMOUS_TRAVEL_TTL
      ) {
        if (isMatchingTravelTask(agent, pending)) {
          delete agent.task;
          stateDirty = true;
        }
        await this.releaseAutonomousSupplyClaim(pending.claimId);
        continue;
      }

      if (samePosition(agent.position, pending.boundaryTarget)) {
        agent.task = {
          source: "autonomy",
          issuedAtTick: pending.issuedAtTick,
          type: "gather",
          resource: pending.resource,
        };
        agent.status = `scouting ${pending.neighborRegionId} for ${pending.resource}`;
        stateDirty = true;
        continue;
      }

      if (!isMatchingTravelTask(agent, pending)) {
        agent.task = {
          source: "autonomy",
          issuedAtTick: pending.issuedAtTick,
          type: "move",
          target: { ...pending.boundaryTarget },
        };
        agent.status = `traveling toward ${pending.neighborRegionId} for ${pending.resource}`;
        stateDirty = true;
      }
      keep.push(pending);
    }

    if (keep.length !== travels.length) {
      await this.autonomyState.storage.put(AUTONOMOUS_TRAVELS_KEY, keep);
    }
    if (stateDirty) this.replaceRuntimeState(state);
    return keep.length;
  }

  private async startAutonomousTravels(
    state: WorldState,
    availableSlots: number,
    cachedHalo: readonly HexHaloTile[] = [],
    cachedDirections: readonly HexGridDirection[] = [],
  ): Promise<number> {
    if (availableSlots <= 0 || !shouldScoutAutonomyHalo(state)) return 0;
    const loadedDirections = new Set(cachedDirections);
    const missingDirections = HEX_GRID_DIRECTIONS.filter((direction) => !loadedDirections.has(direction));
    const halo = missingDirections.length === 0
      ? [...cachedHalo]
      : [
          ...cachedHalo,
          ...(await this.materializeAutonomyHalo(state, missingDirections)),
        ];
    const claims = await this.activeAutonomousSupplyClaims(state.tick);
    const travels = await this.autonomousTravels();
    const workingClaims = [...claims];
    const added: PendingAutonomousTravel[] = [];

    while (added.length < availableSlots) {
      const plan = planAutonomousHaloTravel(state, halo, workingClaims);
      if (plan === undefined) break;
      const agent = state.agents.find((entry) => entry.id === plan.agentId);
      if (agent === undefined) break;

      const claimId = `autonomy-claim:${state.regionId}:${plan.agentId}:${state.tick}:${plan.direction}:${plan.neighborRegionId}`;
      const pendingPlan: PendingAutonomousTravel = { ...plan, claimId };
      const claimedSupply = plan.claimedSupply ?? 0;
      if (claimedSupply > 0) {
        workingClaims.push({
          claimId,
          agentId: plan.agentId,
          resource: plan.resource,
          direction: plan.direction,
          neighborRegionId: plan.neighborRegionId,
          amount: claimedSupply,
          expiresAtTick: state.tick + AUTONOMOUS_SUPPLY_CLAIM_TTL,
          returnToSourceStorage: hasActiveFactionStructure(state, agent.factionId),
        });
      }
      agent.task = {
        source: "autonomy",
        issuedAtTick: plan.issuedAtTick,
        type: "move",
        target: { ...plan.boundaryTarget },
      };
      agent.status = `traveling toward ${plan.neighborRegionId} for ${plan.resource}`;
      added.push(pendingPlan);
    }

    if (added.length === 0) return 0;
    await this.autonomyState.storage.put(AUTONOMOUS_SUPPLY_CLAIMS_KEY, workingClaims);
    await this.autonomyState.storage.put(AUTONOMOUS_TRAVELS_KEY, [...travels, ...added]);
    this.replaceRuntimeState(state);
    return added.length;
  }

  private async resumeSettlementMigration(
    state: WorldState,
  ): Promise<"traveling" | "handoff" | undefined> {
    const pending = await this.autonomyState.storage.get<AutonomousSettlementMigrationPlan | null>(
      AUTONOMOUS_SETTLEMENT_MIGRATION_KEY,
    );
    if (pending === undefined || pending === null) return undefined;
    const agent = state.agents.find((entry) => entry.id === pending.agentId);
    const matchingMove =
      agent?.task?.source === "autonomy"
      && agent.task.type === "move"
      && samePosition(agent.task.target, pending.boundaryTarget);
    if (
      agent === undefined
      || !agent.autonomy
      || agent.task?.source === "external"
      || agent.energy <= LOW_ENERGY_THRESHOLD
      || state.tick - pending.startedAtTick > SETTLEMENT_MIGRATION_TTL
    ) {
      if (agent !== undefined && matchingMove) {
        delete agent.task;
        agent.status = "settlement migration cancelled; replanning";
        this.replaceRuntimeState(state);
      }
      await this.autonomyState.storage.put(AUTONOMOUS_SETTLEMENT_MIGRATION_KEY, null);
      return undefined;
    }

    if (samePosition(agent.position, pending.boundaryTarget)) {
      const step = HEX_GRID_DIRECTION_STEPS[pending.direction];
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
      if (transition?.targetRegionId !== pending.neighborRegionId) {
        if (matchingMove) delete agent.task;
        agent.status = "settlement migration route changed; replanning";
        this.replaceRuntimeState(state);
        await this.autonomyState.storage.put(AUTONOMOUS_SETTLEMENT_MIGRATION_KEY, null);
        return undefined;
      }
      const handoff: PendingAutonomousHandoff = {
        transferId: `settlement:${state.regionId}:${agent.id}:${pending.issuedAtTick}:${pending.direction}`,
        agentId: agent.id,
        direction: pending.direction,
        resource: undefined,
        desiredPosition,
        settlementMigration: true,
      };
      await this.autonomyState.storage.put(AUTONOMOUS_HANDOFF_KEY, handoff);
      await this.autonomyState.storage.put(AUTONOMOUS_SETTLEMENT_MIGRATION_KEY, null);
      await this.attemptPendingHandoff(handoff);
      return "handoff";
    }

    if (!matchingMove) {
      agent.task = {
        source: "autonomy",
        issuedAtTick: pending.issuedAtTick,
        type: "move",
        target: { ...pending.boundaryTarget },
      };
      agent.status = `pioneering toward ${pending.neighborRegionId}`;
      this.replaceRuntimeState(state);
    }
    return "traveling";
  }

  private async startSettlementMigration(
    state: WorldState,
    halo: readonly HexHaloTile[],
  ): Promise<boolean> {
    if (!shouldScoutSettlementMigration(state)) return false;
    const plan = planAutonomousSettlementMigration(state, halo);
    if (plan === undefined || !prepareSettlementMigrationKit(state, plan.agentId)) return false;
    const agent = state.agents.find((entry) => entry.id === plan.agentId);
    if (agent === undefined) return false;
    agent.task = {
      source: "autonomy",
      issuedAtTick: plan.issuedAtTick,
      type: "move",
      target: { ...plan.boundaryTarget },
    };
    agent.status = `carrying a camp kit toward ${plan.neighborRegionId}`;
    await this.autonomyState.storage.put(AUTONOMOUS_SETTLEMENT_MIGRATION_KEY, plan);
    this.replaceRuntimeState(state);
    return true;
  }

  private async resumeOrPlanAutonomousHandoff(state: WorldState): Promise<void> {
    const pending = await this.autonomyState.storage.get<PendingAutonomousHandoff | null>(AUTONOMOUS_HANDOFF_KEY);
    if (pending !== undefined && pending !== null) {
      await this.attemptPendingHandoff(pending);
      return;
    }
    const activeTravels = await this.resumeAutonomousTravels(state);
    const migrationState = await this.resumeSettlementMigration(state);
    if (migrationState === "handoff") return;

    const directions = autonomyHaloPlanningDirections(state);
    const scoutDue = shouldScoutAutonomyHalo(state);
    const migrationDue = migrationState === undefined && shouldScoutSettlementMigration(state);
    const loadedDirections = (scoutDue && directions.length > 0) || migrationDue
      ? HEX_GRID_DIRECTIONS
      : directions;
    let halo: HexHaloTile[] = [];
    if (loadedDirections.length > 0) {
      halo = await this.materializeAutonomyHalo(state, loadedDirections);
      const claims = await this.activeAutonomousSupplyClaims(state.tick);
      const plan = directions.length > 0
        ? planAutonomousHaloHandoff(state, halo, claims)
        : undefined;
      if (plan !== undefined) {
        const pendingPlan: PendingAutonomousHandoff = {
          transferId: plan.transferId,
          agentId: plan.agentId,
          direction: plan.direction,
          resource: plan.resource,
          ...(plan.desiredPosition === undefined
            ? {}
            : { desiredPosition: { ...plan.desiredPosition } }),
          ...(plan.claimId === undefined ? {} : { claimId: plan.claimId }),
          ...(plan.returnToSourceStorage === true ? { returnToSourceStorage: true } : {}),
        };
        await this.autonomyState.storage.put(AUTONOMOUS_HANDOFF_KEY, pendingPlan);
        await this.attemptPendingHandoff(pendingPlan);
        return;
      }
    }

    if (migrationDue) await this.startSettlementMigration(state, halo);

    await this.startAutonomousTravels(
      state,
      Math.max(0, MAX_CONCURRENT_AUTONOMOUS_TRAVELS - activeTravels),
      halo,
      loadedDirections,
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(INTERNAL_AUTONOMY_PREFIX)) {
      return ["GET", "HEAD", "OPTIONS"].includes(request.method)
        ? this.fetchAutonomyRequest(request)
        : this.withHaloEdgeMutation(() => this.fetchAutonomyRequest(request));
    }
    return super.fetch(request);
  }

  private async fetchAutonomyRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const assignmentError = await this.ensureAutonomyAssigned(request);
    if (assignmentError !== undefined) return assignmentError;
    if (request.method === "POST" && url.pathname === INTERNAL_CLAIM_REGISTER_PATH) {
      return this.registerArrivalClaim(request);
    }
    if (request.method === "POST" && url.pathname === INTERNAL_CLAIM_SETTLE_PATH) {
      return this.settleArrivalSourceClaim(request);
    }
    if (request.method === "POST" && url.pathname === INTERNAL_CLAIM_RELEASE_PATH) {
      return this.releaseArrivalSourceClaim(request);
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  private async runSingleAlarmTick(): Promise<void> {
    const ownsEdgeReadBatch = this.beginHaloEdgeReadBatch();
    try {
      const before = runtimeAccess(this).runtime.snapshot();
      await this.resumeOrPlanAutonomousHandoff(before);
      const simulationBefore = runtimeAccess(this).runtime.snapshot();
      await super.alarm();
      await this.reconcileArrivalClaims(
        simulationBefore,
        runtimeAccess(this).runtime.snapshot(),
      );
    } finally {
      this.endHaloEdgeReadBatch(ownsEdgeReadBatch);
    }
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const ticks = this.virtualTicksForAlarm(now);
    const ownsEdgeReadBatch = this.beginHaloEdgeReadBatch();
    let completed = false;
    try {
      for (let index = 0; index < ticks; index += 1) {
        this.setAlarmRescheduleDeferred(index + 1 < ticks);
        await this.runSingleAlarmTick();
      }
      completed = true;
    } finally {
      this.setAlarmRescheduleDeferred(false);
      this.endHaloEdgeReadBatch(ownsEdgeReadBatch);
      if (!completed) await this.scheduleCatchUpIfBehind(Date.now());
    }
    await this.scheduleCatchUpIfBehind(Date.now(), CATCH_UP_RETRY_MS);
  }
}
