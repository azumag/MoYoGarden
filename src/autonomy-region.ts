import {
  materializeHexHalo,
  type HexHaloEdgeSnapshot,
  type HexHaloLink,
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
  BUILD_RECIPES,
  inventoryTotal,
  positionKey,
  type Agent,
  type GridPosition,
  type ResourceKind,
  type WorldState,
} from "./protocol.js";
import {
  hexDistance,
  regionAxialCoordinate,
  regionCellTransition,
} from "./region-topology.js";
import { globalHandoffAgentId } from "./agent-ownership.js";
import {
  hasSettlementFamilyFollow,
  planAutonomousSettlementMigration,
  planSettlementFamilyFollow,
  prepareSettlementMigrationKit,
  registerSettlementFamilyFollowers,
  settlementFamilyAdmissionHeadroom,
  settlementFamilyRegistrationDeferred,
  shouldScoutSettlementMigration,
  type AutonomousSettlementMigrationPlan,
} from "./settlement-migration.js";
import {
  normalizeSettlementFamilyAdmissionReservations,
  settlementFamilyReservedSlots,
  upsertSettlementFamilyAdmissionReservation,
  type SettlementFamilyAdmissionReservation,
} from "./settlement-family-reservation.js";
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
  // Preserve the ultimate claim owner when gathered cargo is relayed through
  // an intermediate region. Optional for rolling compatibility with old pending
  // handoffs, where the immediate source remains the claim owner.
  claimSourceRegionId?: string;
  desiredPosition?: GridPosition;
  returnToSourceStorage?: boolean;
  settlementMigration?: boolean;
  settlementFamilyFollow?: boolean;
  tradeTargetAgentId?: string;
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
  // Observed remote capacity after subtracting reservations made by other
  // concurrent expeditions from this source DO. Optional for rolling deploys.
  destinationStorageHeadroom?: number;
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
  // Optional during rolling deploys. New return reservations retain the
  // source faction so storage headroom remains reserved after the BOT has
  // already handed off and is no longer present in the source WorldState.
  sourceFactionId?: string;
  returnToSourceStorage?: boolean;
  // Capacity promised by the source settlement for cargo already gathered but
  // still physically in transit. `amount` separately tracks unclaimed supply.
  returnStorageAmount?: number;
  // Crash-safe wall-clock lease for source storage promised to cargo in transit.
  // Optional so existing persisted claims remain compatible during rolling deploys.
  returnStorageLeaseExpiresAtMs?: number;
  // Source-local reservation against a concrete remote storage observation.
  // It prevents concurrent scouts in this DO from consuming the same bounded
  // destination headroom while legacy/unknown snapshots remain neutral.
  destinationStorageReserved?: boolean;
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
  // Wall-clock time of the last confirmed source-side return-storage lease refresh.
  // Optional so arrival claims persisted by older deployments remain valid.
  returnStorageLeaseRenewedAtMs?: number;
  // Destination-local admitted capacity; optional for rolling compatibility.
  destinationStorageReserved?: boolean;
}

interface AutonomousDestinationStorageReservation {
  claimId: string;
  sourceRegionId: string;
  factionId: string;
  amount: number;
  expiresAtMs: number;
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
const AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY = "handoff:autonomy:destination-storage:v1";
const SETTLEMENT_FAMILY_ADMISSION_RESERVATIONS_KEY = "handoff:autonomy:settlement-family-admission:v1";
const AUTONOMOUS_SETTLEMENT_MIGRATION_KEY = "handoff:autonomy:settlement-migration:v1";
// Shared with handoff-region.ts. The autonomy layer only reads this
// crash-safe journal to resolve the current owner of a world-global BOT.
const OUTGOING_HANDOFF_KEY = "handoff:outgoing:v1";
const INTERNAL_EDGE_PATH = "/api/internal/halo/edge";
const INTERNAL_AUTONOMY_PREFIX = "/api/internal/autonomy/";
const INTERNAL_CLAIM_REGISTER_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/register`;
const INTERNAL_CLAIM_SETTLE_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/settle`;
const INTERNAL_CLAIM_RELEASE_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/release`;
const INTERNAL_STORAGE_RESERVE_PATH = `${INTERNAL_AUTONOMY_PREFIX}storage/reserve`;
const INTERNAL_STORAGE_RELEASE_PATH = `${INTERNAL_AUTONOMY_PREFIX}storage/release`;
const INTERNAL_AGENT_LOOKUP_PATH = `${INTERNAL_AUTONOMY_PREFIX}agent/lookup`;
const INTERNAL_SETTLEMENT_FAMILY_REGISTER_PATH = `${INTERNAL_AUTONOMY_PREFIX}settlement/family/register`;
const LOW_ENERGY_THRESHOLD = 18;
const AUTONOMOUS_SCOUT_INTERVAL = 12;
const AUTONOMOUS_TRAVEL_TTL = 48;
const AUTONOMOUS_SUPPLY_CLAIM_TTL = AUTONOMOUS_TRAVEL_TTL + AUTONOMOUS_SCOUT_INTERVAL;
const MAX_CONCURRENT_AUTONOMOUS_TRAVELS = 3;
// Destination admission uses wall-clock expiry because source and destination
// simulation ticks may advance at different active/warm/cold cadences.
const DESTINATION_STORAGE_RESERVATION_TTL_MS = 15 * 60 * 1_000;
// Family followers can traverse several warm/cold regions after admission.
// Keep promised housing/food capacity for a bounded wall-clock day so a
// second pioneer cannot overbook the same slots while the first wave is
// physically in flight. Arrival reconciliation releases slots immediately.
const SETTLEMENT_FAMILY_ADMISSION_RESERVATION_TTL_MS = 24 * 60 * 60 * 1_000;
// Source simulation ticks can advance much faster than a courier in warm/cold
// relay regions. Keep the promised return sink alive on wall time as well, but
// bound crash leakage so abandoned cargo cannot reserve capacity forever.
const RETURN_STORAGE_RESERVATION_TTL_MS = 6 * 60 * 60 * 1_000;
// A courier carrying promised return cargo periodically refreshes the source-side
// lease. This is deliberately much slower than simulation ticks, so multi-hop
// relays survive long warm/cold journeys without turning every tick into a cross-DO write.
const RETURN_STORAGE_RENEW_INTERVAL_MS = 60 * 60 * 1_000;
const SETTLEMENT_MIGRATION_TTL = 72;
// Keep routing bounded to the same virtual-time window used by simulation's
// promoted remote-trade promise. Discovery itself only fans out on scout cadence.
const AUTONOMOUS_TRADE_DISCOVERY_TTL = 72;
// Owner discovery follows the existing crash-safe handoff journals instead
// of fanning out across whole hex rings. Both directory chasing and the
// trader's physical route stay bounded so stale identities cannot create an
// unbounded chain of Durable Object reads or handoffs.
const AUTONOMOUS_TRADE_MAX_DIRECTORY_HOPS = 6;
const AUTONOMOUS_TRADE_MAX_ROUTE_HOPS = 6;
// Successful bounded catch-up batches can drain debt promptly without
// putting dozens of full virtual ticks into one DO invocation. Failed
// batches keep the normal tick retry to avoid a hot failure loop.
const CATCH_UP_RETRY_MS = 1_000;
// Tick count alone does not bound an Alarm when one historical tick is
// slowed by cross-DO work. Yield after a modest wall-clock slice and
// preserve the remaining virtual-time debt for the prompt retry. This
// leaves headroom for outer pathogen/post-processing layers in the same
// Durable Object invocation without skipping any simulation ticks.
const CATCH_UP_WALL_BUDGET_MS = 8_000;

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
    ))
    && (value.destinationStorageHeadroom === undefined || (
      typeof value.destinationStorageHeadroom === "number"
      && Number.isFinite(value.destinationStorageHeadroom)
      && value.destinationStorageHeadroom >= 0
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
    && value.amount >= 0
    && (
      value.amount > 0
      || (
        value.returnToSourceStorage === true
        && typeof value.returnStorageAmount === "number"
        && Number.isFinite(value.returnStorageAmount)
        && value.returnStorageAmount > 0
      )
    )
    && (value.settledAmount === undefined || (
      typeof value.settledAmount === "number"
      && Number.isFinite(value.settledAmount)
      && value.settledAmount >= 0
    ))
    && typeof value.expiresAtTick === "number"
    && Number.isInteger(value.expiresAtTick)
    && (value.sourceFactionId === undefined || typeof value.sourceFactionId === "string")
    && (value.returnToSourceStorage === undefined || typeof value.returnToSourceStorage === "boolean")
    && (value.returnStorageAmount === undefined || (
      typeof value.returnStorageAmount === "number"
      && Number.isFinite(value.returnStorageAmount)
      && value.returnStorageAmount >= 0
    ))
    && (value.returnStorageLeaseExpiresAtMs === undefined || (
      typeof value.returnStorageLeaseExpiresAtMs === "number"
      && Number.isFinite(value.returnStorageLeaseExpiresAtMs)
      && value.returnStorageLeaseExpiresAtMs > 0
    ))
    && (value.destinationStorageReserved === undefined || typeof value.destinationStorageReserved === "boolean");
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
    && (value.returnToSourceStorage === undefined || typeof value.returnToSourceStorage === "boolean")
    && (value.returnStorageLeaseRenewedAtMs === undefined || (
      typeof value.returnStorageLeaseRenewedAtMs === "number"
      && Number.isFinite(value.returnStorageLeaseRenewedAtMs)
      && value.returnStorageLeaseRenewedAtMs > 0
    ))
    && (value.destinationStorageReserved === undefined || typeof value.destinationStorageReserved === "boolean");
}

function isDestinationStorageReservation(
  value: unknown,
): value is AutonomousDestinationStorageReservation {
  return isRecord(value)
    && typeof value.claimId === "string"
    && value.claimId.length > 0
    && typeof value.sourceRegionId === "string"
    && value.sourceRegionId.length > 0
    && typeof value.factionId === "string"
    && value.factionId.length > 0
    && typeof value.amount === "number"
    && Number.isFinite(value.amount)
    && value.amount > 0
    && typeof value.expiresAtMs === "number"
    && Number.isFinite(value.expiresAtMs)
    && value.expiresAtMs > 0;
}

function inventoryAmount(agent: Agent): number {
  return agent.inventory.wood + agent.inventory.stone + agent.inventory.food;
}

function hasActiveFactionStructure(state: WorldState, factionId: string): boolean {
  return state.structures.some((structure) =>
    structure.factionId === factionId && structure.status === "active"
  );
}

function factionStorageCapacityLeft(state: WorldState, factionId: string): number {
  return state.structures
    .filter((structure) =>
      structure.factionId === factionId && structure.status === "active"
    )
    .reduce((available, structure) =>
      available + Math.max(
        0,
        BUILD_RECIPES[structure.type].storageCapacity - inventoryTotal(structure.storage),
      ),
    0);
}

function hasAvailableFactionStorage(state: WorldState, factionId: string): boolean {
  return factionStorageCapacityLeft(state, factionId) > 0;
}

function returnStorageReservationActive(
  stateTick: number,
  claim: AutonomousSupplyClaim,
  now = Date.now(),
): boolean {
  if (claim.returnToSourceStorage !== true) return false;
  const reservedAmount = claim.returnStorageAmount ?? claim.amount;
  if (reservedAmount <= 0) return false;
  return claim.expiresAtTick > stateTick
    || (claim.returnStorageLeaseExpiresAtMs ?? 0) > now;
}

function reservedReturnStorageForFaction(
  state: WorldState,
  claims: readonly AutonomousSupplyClaim[],
  factionId: string,
): number {
  const now = Date.now();
  return claims.reduce((reserved, claim) => {
    if (!returnStorageReservationActive(state.tick, claim, now)) return reserved;
    const reservedAmount = claim.returnStorageAmount ?? claim.amount;
    if (reservedAmount <= 0) return reserved;
    if (claim.sourceFactionId !== undefined) {
      return claim.sourceFactionId === factionId ? reserved + reservedAmount : reserved;
    }
    const localAgent = claim.agentId === undefined
      ? undefined
      : state.agents.find((entry) => entry.id === claim.agentId);
    if (localAgent !== undefined) {
      return localAgent.factionId === factionId ? reserved + reservedAmount : reserved;
    }
    // Rolling-deploy compatibility: an older in-flight return claim can
    // outlive its source-side BOT. Without a persisted faction we cannot prove
    // it belongs elsewhere, so reserve its amount conservatively for every
    // faction until the short claim TTL expires instead of overbooking.
    return reserved + reservedAmount;
  }, 0);
}

function reservedDestinationStorageForFaction(
  state: WorldState,
  claims: readonly AutonomousSupplyClaim[],
  neighborRegionId: string,
  factionId: string,
): number {
  return claims.reduce((reserved, claim) => {
    if (
      claim.destinationStorageReserved !== true ||
      claim.neighborRegionId !== neighborRegionId ||
      claim.expiresAtTick <= state.tick
    ) {
      return reserved;
    }
    return claim.sourceFactionId === factionId ? reserved + claim.amount : reserved;
  }, 0);
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

function regionDistanceToTarget(
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
  return {
    transferId: `return:${state.regionId}:${agent.id}:${state.tick}:${selected.direction}`,
    agentId: agent.id,
    direction: selected.direction,
    resource: claim.resource,
    desiredPosition: selected.desiredPosition,
    claimId: claim.claimId,
    claimSourceRegionId: claim.sourceRegionId,
    returnToSourceStorage: true,
  };
}

function returnTravelTargetForArrival(
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

interface LocalTravelPathScore {
  distance: number;
  crowding: number;
}

function localTravelPathScores(
  state: WorldState,
  start: GridPosition,
): Map<string, LocalTravelPathScore> {
  const scores = new Map<string, LocalTravelPathScore>([
    [positionKey(start), { distance: 0, crowding: 0 }],
  ]);
  const crowdingByPosition = new Map<string, number>();
  for (const occupant of state.agents) {
    if (occupant.hp <= 0) continue;
    const key = positionKey(occupant.position);
    crowdingByPosition.set(key, (crowdingByPosition.get(key) ?? 0) + 1);
  }
  const queue: GridPosition[] = [{ ...start }];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) break;
    const currentScore = scores.get(positionKey(current));
    if (currentScore === undefined) continue;
    for (const direction of HEX_GRID_DIRECTIONS) {
      const step = HEX_GRID_DIRECTION_STEPS[direction];
      const next = { x: current.x + step.x, y: current.y + step.y };
      if (!isPassable(state, next)) continue;
      const key = positionKey(next);
      const candidate: LocalTravelPathScore = {
        distance: currentScore.distance + 1,
        crowding: currentScore.crowding + (crowdingByPosition.get(key) ?? 0),
      };
      const existing = scores.get(key);
      if (
        existing !== undefined &&
        (existing.distance < candidate.distance ||
          (existing.distance === candidate.distance && existing.crowding <= candidate.crowding))
      ) {
        continue;
      }
      scores.set(key, candidate);
      queue.push(next);
    }
  }

  return scores;
}

function remainingInventoryCapacity(agent: Agent): number {
  return Math.max(0, agent.capacity - inventoryAmount(agent));
}

export interface AutonomousTradeNeighborRoute {
  direction: HexGridDirection;
  neighborRegionId: string;
  boundaryTarget: GridPosition;
  desiredPosition: GridPosition;
}

interface TradeCounterpartyLookup {
  present: boolean;
  forwardedRegionId?: string;
  handoffPending?: boolean;
}

interface TradeDirectoryRecord {
  globalAgentId: string;
  phase: "reserved" | "detached" | "committed";
  toRegionId: string;
  updatedAtTick: number;
  createdAtTick: number;
  transferId: string;
}

function globalTradeOriginRegionId(agentId: string): string | undefined {
  const prefix = "agent-global:";
  if (!agentId.startsWith(prefix)) return undefined;
  const remainder = agentId.slice(prefix.length);
  const separator = remainder.indexOf(":");
  if (separator <= 0) return undefined;
  const regionId = remainder.slice(0, separator);
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(regionId) ? regionId : undefined;
}

function tradeDirectoryRecord(value: unknown): TradeDirectoryRecord | undefined {
  if (!isRecord(value) || !isRecord(value.envelope) || !isRecord(value.envelope.agent)) {
    return undefined;
  }
  const phase = value.phase;
  const fromRegionId = value.envelope.fromRegionId;
  const toRegionId = value.envelope.toRegionId;
  const agentId = value.envelope.agent.id;
  const transferId = value.envelope.transferId;
  const updatedAtTick = typeof value.updatedAtTick === "number" ? value.updatedAtTick : Number.NaN;
  const createdAtTick = typeof value.envelope.createdAtTick === "number" ? value.envelope.createdAtTick : Number.NaN;
  if (
    (phase !== "reserved" && phase !== "detached" && phase !== "committed")
    || typeof fromRegionId !== "string"
    || typeof toRegionId !== "string"
    || typeof agentId !== "string"
    || typeof transferId !== "string"
    || !Number.isInteger(updatedAtTick)
    || !Number.isInteger(createdAtTick)
  ) return undefined;
  return {
    globalAgentId: globalHandoffAgentId(agentId, fromRegionId),
    phase,
    toRegionId,
    updatedAtTick,
    createdAtTick,
    transferId,
  };
}

export function planAutonomousTradeNeighborRoute(
  state: WorldState,
  links: readonly HexHaloLink[],
  agentId: string,
  targetRegionId: string,
): AutonomousTradeNeighborRoute | undefined {
  const agent = state.agents.find((entry) => entry.id === agentId);
  if (
    agent === undefined
    || !agent.autonomy
    || agent.task?.source !== "autonomy"
    || agent.task.type !== "trade"
  ) return undefined;

  const sourceAxial = regionAxialCoordinate(state.regionId);
  const targetAxial = regionAxialCoordinate(targetRegionId);
  if (sourceAxial === undefined || targetAxial === undefined) return undefined;
  const currentDistance = hexDistance(sourceAxial, targetAxial);
  if (currentDistance <= 0) return undefined;

  const scores = localTravelPathScores(state, agent.position);
  const selected = links
    .filter((link) => {
      const neighborAxial = regionAxialCoordinate(link.neighborRegionId);
      return neighborAxial !== undefined
        && hexDistance(neighborAxial, targetAxial) === currentDistance - 1
        && isPassable(state, link.sourcePosition);
    })
    .flatMap((link) => {
      const score = scores.get(positionKey(link.sourcePosition));
      return score === undefined ? [] : [{ link, score }];
    })
    .sort((a, b) =>
      a.score.distance - b.score.distance
      || a.score.crowding - b.score.crowding
      || directionRank(a.link.direction) - directionRank(b.link.direction)
      || a.link.sourcePosition.y - b.link.sourcePosition.y
      || a.link.sourcePosition.x - b.link.sourcePosition.x
    )[0];
  if (selected === undefined) return undefined;
  const step = HEX_GRID_DIRECTION_STEPS[selected.link.direction];
  return {
    direction: selected.link.direction,
    neighborRegionId: selected.link.neighborRegionId,
    boundaryTarget: { ...selected.link.sourcePosition },
    desiredPosition: {
      x: selected.link.sourcePosition.x + step.x,
      y: selected.link.sourcePosition.y + step.y,
    },
  };
}
function haloSupplyKey(neighborRegionId: string): string {
  return neighborRegionId;
}

function haloSupplyCellKey(entry: Pick<HexHaloTile, "neighborRegionId" | "neighborPosition">): string {
  return `${entry.neighborRegionId}:${entry.neighborPosition.x},${entry.neighborPosition.y}`;
}

function haloRegionResourceSupply(
  halo: readonly HexHaloTile[],
  resource: ResourceKind,
  neighborRegionId: string,
): number {
  let summarizedSupply: number | undefined;
  let boundarySupply = 0;
  const seenCells = new Set<string>();
  for (const entry of halo) {
    if (entry.neighborRegionId !== neighborRegionId) continue;
    const summarySupply = entry.neighborRegionSummary?.resources[resource];
    if (typeof summarySupply === "number" && Number.isFinite(summarySupply) && summarySupply >= 0) {
      summarizedSupply = Math.max(summarizedSupply ?? 0, summarySupply);
    }
    if (
      entry.tile.terrain === "water" ||
      entry.tile.resource?.kind !== resource ||
      entry.tile.resource.amount <= 0
    ) continue;
    const cellKey = haloSupplyCellKey(entry);
    if (seenCells.has(cellKey)) continue;
    seenCells.add(cellKey);
    boundarySupply += entry.tile.resource.amount;
  }
  // A new snapshot's whole-region summary is authoritative for physical supply.
  // Legacy snapshots fall back to the previous exact-boundary observation.
  return summarizedSupply ?? boundarySupply;
}

function haloRegionFactionStorageHeadroom(
  halo: readonly HexHaloTile[],
  neighborRegionId: string,
  factionId: string,
): number | undefined {
  let minimumHeadroom: number | undefined;
  for (const entry of halo) {
    if (entry.neighborRegionId !== neighborRegionId) continue;
    const byFaction = entry.neighborRegionSummary?.storageHeadroomByFaction;
    if (byFaction === undefined || !Object.prototype.hasOwnProperty.call(byFaction, factionId)) continue;
    const headroom = byFaction[factionId];
    if (typeof headroom !== "number" || !Number.isFinite(headroom) || headroom < 0) continue;
    // Multiple seam reads can straddle ticks. Treat this as a routing hint, not
    // a reservation, and use the most conservative observation, including zero
    // when the remote faction's active storage is explicitly known to be full.
    minimumHeadroom = Math.min(minimumHeadroom ?? headroom, headroom);
  }
  return minimumHeadroom;
}

function storageHeadroomPreference(headroom: number | undefined): number {
  // Positive observed capacity is best; missing bounded metadata stays neutral;
  // an explicit zero is actionable evidence that the destination is full.
  if (headroom === undefined) return 1;
  return headroom > 0 ? 2 : 0;
}

function availableHaloSupplyForAgent(
  state: Pick<WorldState, "tick">,
  halo: readonly HexHaloTile[],
  claims: readonly AutonomousSupplyClaim[],
  agentId: string,
  resource: ResourceKind,
  neighborRegionId: string,
): number {
  const visibleSupply = haloRegionResourceSupply(halo, resource, neighborRegionId);

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
    pathCrowding: number;
    destinationCrowding: number;
    destinationStorageHeadroom: number | undefined;
    costPerUnit: number;
  }> = [];

  for (const agent of state.agents) {
    if (!agent.autonomy || isBoundaryPosition(state, agent.position)) continue;
    const resource = resourceIntent(state, agent);
    if (resource === undefined || localResourceAvailable(state, resource)) continue;

    const capacityLeft = remainingInventoryCapacity(agent);
    if (capacityLeft <= 0) continue;
    const travelEnergyBudget = Math.max(0, agent.energy - LOW_ENERGY_THRESHOLD);
    const pathScores = localTravelPathScores(state, agent.position);
    // The existing edge read can now report bounded whole-region supply. This
    // allows a worker to cross a passable seam toward interior resources instead
    // of requiring the deposit itself to sit on the border. Legacy snapshots
    // still behave exactly as before because the helper falls back to edge cells.
    const visibleSupply = new Map<string, number>();
    for (const neighborRegionId of new Set(halo.map((entry) => entry.neighborRegionId))) {
      visibleSupply.set(
        haloSupplyKey(neighborRegionId),
        haloRegionResourceSupply(halo, resource, neighborRegionId),
      );
    }
    const destinationStorageHeadroom = new Map<string, number | undefined>();
    for (const neighborRegionId of new Set(halo.map((entry) => entry.neighborRegionId))) {
      const observedHeadroom = haloRegionFactionStorageHeadroom(halo, neighborRegionId, agent.factionId);
      const reservedHeadroom = reservedDestinationStorageForFaction(
        state,
        claims,
        neighborRegionId,
        agent.factionId,
      );
      destinationStorageHeadroom.set(
        neighborRegionId,
        observedHeadroom === undefined ? undefined : Math.max(0, observedHeadroom - reservedHeadroom),
      );
    }
    const availableSourceReturnStorage = Math.max(
      0,
      factionStorageCapacityLeft(state, agent.factionId)
        - reservedReturnStorageForFaction(state, claims, agent.factionId),
    );
    const candidates = halo.flatMap((entry) => {
      const pathScore = pathScores.get(positionKey(entry.sourcePosition));
      if (
        pathScore === undefined ||
        pathScore.distance > travelEnergyBudget ||
        entry.tile.terrain === "water" ||
        (visibleSupply.get(haloSupplyKey(entry.neighborRegionId)) ?? 0) <= 0
      ) {
        return [];
      }
      const remoteStorageHeadroom = destinationStorageHeadroom.get(entry.neighborRegionId);
      // Do not launch cargo toward a destination that is explicitly known to
      // have no storage when this source also has no unreserved return capacity.
      // Missing remote metadata stays neutral for rolling compatibility: only
      // two concrete capacity observations can prove the expedition has no sink.
      if (remoteStorageHeadroom === 0 && availableSourceReturnStorage <= 0) return [];
      return [{
        entry,
        travelDistance: pathScore.distance,
        pathCrowding: pathScore.crowding,
        destinationCrowding: entry.neighborOccupants ?? 0,
        destinationStorageHeadroom: remoteStorageHeadroom,
      }];
    });
    const claimedSupply = new Map<string, number>();
    for (const claim of claims) {
      if (claim.resource !== resource || claim.expiresAtTick <= state.tick) continue;
      const key = haloSupplyKey(claim.neighborRegionId);
      claimedSupply.set(key, (claimedSupply.get(key) ?? 0) + claim.amount);
    }

    const candidate = candidates
      .flatMap(({ entry, travelDistance, pathCrowding, destinationCrowding, destinationStorageHeadroom }) => {
        const key = haloSupplyKey(entry.neighborRegionId);
        const availableSupply = Math.max(
          0,
          (visibleSupply.get(key) ?? 0) - (claimedSupply.get(key) ?? 0),
        );
        const supply = Math.min(capacityLeft, availableSupply);
        // When the source cannot promise a return sink, a concrete remote
        // storage observation is also an upper bound on useful cargo. This
        // does not turn the halo summary into a reservation: concurrent
        // sources can still race, but one expedition no longer knowingly
        // gathers more than the only observed sink can accept. Missing
        // metadata stays backward-compatible and leaves the old sizing intact.
        const sinkBoundedSupply =
          destinationStorageHeadroom !== undefined && availableSourceReturnStorage <= 0
            ? Math.min(supply, destinationStorageHeadroom)
            : supply;
        if (sinkBoundedSupply <= 0) return [];
        return [{
          entry,
          travelDistance,
          pathCrowding,
          destinationCrowding,
          destinationStorageHeadroom,
          visibleSupply: sinkBoundedSupply,
          // Crowding is a planning friction, not literal energy consumption.
          // Keep the existing distance-only energy reserve while preferring a
          // quiet source corridor and an unjammed arrival cell when neighboring
          // supplies are otherwise alike. The remote signal rides the same
          // bounded halo edge read, so it does not deepen or widen fan-out.
          costPerUnit: (travelDistance + pathCrowding + destinationCrowding) / supply,
        }];
      })
      .sort((a, b) =>
        a.costPerUnit - b.costPerUnit
        || b.visibleSupply - a.visibleSupply
        || a.travelDistance - b.travelDistance
        || a.pathCrowding - b.pathCrowding
        || a.destinationCrowding - b.destinationCrowding
        // Equivalent routes should prefer a region that currently has positive
        // storage headroom for this BOT's own faction. This is deliberately a
        // tie-break only: remote headroom is not reserved and can change before
        // arrival, while the existing source-return promise remains the fallback.
        || storageHeadroomPreference(b.destinationStorageHeadroom)
          - storageHeadroomPreference(a.destinationStorageHeadroom)
        || (b.destinationStorageHeadroom ?? 0) - (a.destinationStorageHeadroom ?? 0)
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
      pathCrowding: candidate.pathCrowding,
      destinationCrowding: candidate.destinationCrowding,
      destinationStorageHeadroom: candidate.destinationStorageHeadroom,
      costPerUnit: candidate.costPerUnit,
    });
  }

  const expedition = expeditions.sort((a, b) =>
    a.costPerUnit - b.costPerUnit
    || b.visibleSupply - a.visibleSupply
    || a.travelDistance - b.travelDistance
    || a.pathCrowding - b.pathCrowding
    || a.destinationCrowding - b.destinationCrowding
    || storageHeadroomPreference(b.destinationStorageHeadroom)
      - storageHeadroomPreference(a.destinationStorageHeadroom)
    || (b.destinationStorageHeadroom ?? 0) - (a.destinationStorageHeadroom ?? 0)
    // Equivalent expeditions should use the BOT with more remaining energy;
    // low-energy workers are more useful staying near the current settlement.
    || b.agent.energy - a.agent.energy
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
    ...(expedition.destinationStorageHeadroom === undefined
      ? {}
      : { destinationStorageHeadroom: expedition.destinationStorageHeadroom }),
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
        entry.tile.terrain !== "water"
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
      .filter(({ entry, claim }) => {
        const concreteBoundarySupply =
          entry.tile.resource?.kind === resource && entry.tile.resource.amount > 0;
        // An interior traveler may cross an empty boundary only when it already
        // owns the source-side region reservation. Unreserved boundary handoffs
        // retain the old concrete-deposit requirement, preventing double-booking.
        if (!concreteBoundarySupply && claim === undefined) return false;
        return availableHaloSupplyForAgent(
          state,
          halo,
          claims,
          agent.id,
          resource,
          entry.neighborRegionId,
        ) > 0;
      })
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
    const now = Date.now();
    let upgraded = false;
    const normalized = valid.map((claim) => {
      const reservedAmount = claim.returnStorageAmount ?? claim.amount;
      if (
        claim.returnToSourceStorage === true
        && reservedAmount > 0
        && claim.returnStorageLeaseExpiresAtMs === undefined
        && claim.expiresAtTick > tick
      ) {
        upgraded = true;
        return {
          ...claim,
          returnStorageLeaseExpiresAtMs: now + RETURN_STORAGE_RESERVATION_TTL_MS,
        };
      }
      return claim;
    });
    const active = normalized.filter((claim) =>
      claim.expiresAtTick > tick || returnStorageReservationActive(tick, claim, now)
    );
    if (!Array.isArray(stored) || active.length !== stored.length || upgraded) {
      await this.autonomyState.storage.put(AUTONOMOUS_SUPPLY_CLAIMS_KEY, active);
    }
    return active;
  }

  private async releaseRemoteDestinationStorageReservation(
    claim: AutonomousSupplyClaim | undefined,
  ): Promise<void> {
    if (claim?.destinationStorageReserved !== true) return;
    const sourceRegionId = runtimeAccess(this).runtime.snapshot().regionId;
    try {
      await this.autonomyStub(claim.neighborRegionId).fetch(new Request(
        `https://moyo.internal${INTERNAL_STORAGE_RELEASE_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-moyo-region-internal": claim.neighborRegionId,
          },
          body: JSON.stringify({ claimId: claim.claimId, sourceRegionId }),
        },
      ));
    } catch {
      // The destination-side wall-clock TTL is the crash-safe fallback. A
      // failed best-effort release can temporarily underbook, never overbook.
    }
  }

  private async releaseAutonomousSupplyClaim(claimId: string | undefined): Promise<void> {
    if (claimId === undefined) return;
    const stored = await this.autonomyState.storage.get<unknown>(AUTONOMOUS_SUPPLY_CLAIMS_KEY);
    if (!Array.isArray(stored)) return;
    const valid = stored.filter(isAutonomousSupplyClaim);
    const released = valid.find((claim) => claim.claimId === claimId);
    const next = valid.filter((claim) => claim.claimId !== claimId);
    if (next.length !== stored.length) {
      await this.autonomyState.storage.put(AUTONOMOUS_SUPPLY_CLAIMS_KEY, next);
    }
    await this.releaseRemoteDestinationStorageReservation(released);
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

  private async activeDestinationStorageReservations(
    now = Date.now(),
  ): Promise<AutonomousDestinationStorageReservation[]> {
    const stored = await this.autonomyState.storage.get<unknown>(
      AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY,
    );
    const valid = Array.isArray(stored)
      ? stored.filter(isDestinationStorageReservation)
      : [];

    // The wall-clock TTL is a crash fallback, not permission to reuse
    // capacity that is already committed to cargo physically present on
    // an admitted BOT. Keep such reservations alive from destination-local
    // state so slow/cold delivery cannot silently overbook the same slots.
    const state = runtimeAccess(this).runtime.snapshot();
    const arrivals = await this.arrivalClaims();
    const protectedKeys = new Set<string>();
    for (const claim of arrivals) {
      if (claim.destinationStorageReserved !== true) continue;
      const agent = state.agents.find((entry) => entry.id === claim.agentId);
      if (agent === undefined || agent.inventory[claim.resource] <= 0) continue;
      protectedKeys.add(`${claim.sourceRegionId}\u0000${claim.claimId}`);
    }

    let refreshed = false;
    const active = valid.flatMap((entry) => {
      if (entry.expiresAtMs > now) return [entry];
      if (!protectedKeys.has(`${entry.sourceRegionId}\u0000${entry.claimId}`)) return [];
      refreshed = true;
      return [{ ...entry, expiresAtMs: now + DESTINATION_STORAGE_RESERVATION_TTL_MS }];
    });
    if (!Array.isArray(stored) || active.length !== stored.length || refreshed) {
      await this.autonomyState.storage.put(
        AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY,
        active,
      );
    }
    return active;
  }

  private async reserveDestinationStorage(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "request body must be valid JSON" }), { status: 400 });
    }
    if (
      !isRecord(body)
      || typeof body.claimId !== "string"
      || body.claimId.trim() === ""
      || typeof body.sourceRegionId !== "string"
      || !isAutonomyClaimSourceRegionId(configuredRegionIds(this.autonomyEnv), body.sourceRegionId)
      || typeof body.factionId !== "string"
      || body.factionId.trim() === ""
      || typeof body.amount !== "number"
      || !Number.isFinite(body.amount)
      || body.amount <= 0
    ) {
      return new Response(JSON.stringify({ error: "invalid destination storage reservation" }), {
        status: 400,
      });
    }

    const claimId = body.claimId;
    const sourceRegionId = body.sourceRegionId;
    const factionId = body.factionId;
    const requestedAmount = body.amount;
    const now = Date.now();
    const state = runtimeAccess(this).runtime.snapshot();
    const actualHeadroom = factionStorageCapacityLeft(state, factionId);
    // Reservation admission is rare (only remote-sink expedition launch), so a
    // short Durable Object critical section is preferable to a read/modify/write
    // race across concurrent source regions. Keep only storage I/O and arithmetic
    // inside the gate; no network fetch occurs while concurrency is blocked.
    const result = await this.autonomyState.blockConcurrencyWhile(async () => {
      const stored = await this.autonomyState.storage.get<unknown>(AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY);
      const reservations = Array.isArray(stored)
        ? stored
          .filter(isDestinationStorageReservation)
          .filter((entry) => entry.expiresAtMs > now)
        : [];
      const existing = reservations.find((entry) => entry.claimId === claimId);
      if (existing !== undefined) {
        if (
          existing.sourceRegionId !== sourceRegionId
          || existing.factionId !== factionId
        ) {
          return { conflict: true as const };
        }
        // Idempotent retries from the source also renew the wall-clock lease.
        // This keeps a slow in-flight expedition from losing admitted sink
        // capacity before the ownership handoff installs destination-local
        // arrival tracking.
        const renewed = {
          ...existing,
          expiresAtMs: now + DESTINATION_STORAGE_RESERVATION_TTL_MS,
        };
        await this.autonomyState.storage.put(
          AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY,
          reservations.map((entry) => entry.claimId === claimId ? renewed : entry),
        );
        return {
          conflict: false as const,
          grantedAmount: existing.amount,
          remainingHeadroom: Math.max(
            0,
            actualHeadroom - reservations.reduce(
              (sum, entry) => entry.factionId === factionId ? sum + entry.amount : sum,
              0,
            ),
          ),
          idempotent: true,
        };
      }

      const alreadyReserved = reservations.reduce(
        (sum, entry) => entry.factionId === factionId ? sum + entry.amount : sum,
        0,
      );
      const available = Math.max(0, actualHeadroom - alreadyReserved);
      const grantedAmount = Math.min(requestedAmount, available);
      const next = grantedAmount > 0
        ? [...reservations, {
          claimId: claimId,
          sourceRegionId: sourceRegionId,
          factionId: factionId,
          amount: grantedAmount,
          expiresAtMs: now + DESTINATION_STORAGE_RESERVATION_TTL_MS,
        } satisfies AutonomousDestinationStorageReservation]
        : reservations;
      if (!Array.isArray(stored) || next.length !== stored.length || grantedAmount > 0) {
        await this.autonomyState.storage.put(AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY, next);
      }
      return {
        conflict: false as const,
        grantedAmount,
        remainingHeadroom: Math.max(0, available - grantedAmount),
        idempotent: false,
      };
    });
    if (result.conflict) {
      return new Response(JSON.stringify({ error: "claimId already reserved by another source" }), {
        status: 409,
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      claimId: claimId,
      requestedAmount: requestedAmount,
      grantedAmount: result.grantedAmount,
      remainingHeadroom: result.remainingHeadroom,
      ...(result.idempotent ? { idempotent: true } : {}),
    }), { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  private async releaseDestinationStorageReservation(
    claimId: string,
    sourceRegionId: string,
  ): Promise<void> {
    const now = Date.now();
    await this.autonomyState.blockConcurrencyWhile(async () => {
      const stored = await this.autonomyState.storage.get<unknown>(AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY);
      const reservations = Array.isArray(stored)
        ? stored
          .filter(isDestinationStorageReservation)
          .filter((entry) => entry.expiresAtMs > now)
        : [];
      const next = reservations.filter((entry) =>
        entry.claimId !== claimId || entry.sourceRegionId !== sourceRegionId
      );
      if (!Array.isArray(stored) || next.length !== stored.length) {
        await this.autonomyState.storage.put(AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY, next);
      }
    });
  }

  private async releaseDestinationStorage(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "request body must be valid JSON" }), { status: 400 });
    }
    if (
      !isRecord(body)
      || typeof body.claimId !== "string"
      || body.claimId.trim() === ""
      || typeof body.sourceRegionId !== "string"
      || !isAutonomyClaimSourceRegionId(configuredRegionIds(this.autonomyEnv), body.sourceRegionId)
    ) {
      return new Response(JSON.stringify({ error: "claimId and sourceRegionId are required" }), {
        status: 400,
      });
    }
    await this.releaseDestinationStorageReservation(body.claimId, body.sourceRegionId);
    return new Response(JSON.stringify({ ok: true, claimId: body.claimId }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
private async activeSettlementFamilyAdmissionReservations(
  state: WorldState,
  now = Date.now(),
): Promise<SettlementFamilyAdmissionReservation[]> {
  const stored = await this.autonomyState.storage.get<unknown>(
    SETTLEMENT_FAMILY_ADMISSION_RESERVATIONS_KEY,
  );
  const presentAgentIds = new Set(state.agents.map((agent) => agent.id));
  const normalized = normalizeSettlementFamilyAdmissionReservations(stored, presentAgentIds, now);
  if (normalized.changed) {
    await this.autonomyState.storage.put(
      SETTLEMENT_FAMILY_ADMISSION_RESERVATIONS_KEY,
      normalized.reservations,
    );
  }
  return normalized.reservations;
}

private async reserveSettlementFamilyAdmissions(
  state: WorldState,
  sourceRegionId: string,
  pioneerId: string,
  factionId: string,
  sourceAgentIds: readonly string[],
): Promise<void> {
  const agentIds = [...new Set(sourceAgentIds.map((agentId) =>
    globalHandoffAgentId(agentId, sourceRegionId)
  ))];
  if (agentIds.length === 0) return;
  const reservationId = `family:${sourceRegionId}:${pioneerId}:${state.regionId}`;
  const now = Date.now();
  await this.autonomyState.blockConcurrencyWhile(async () => {
    const stored = await this.autonomyState.storage.get<unknown>(
      SETTLEMENT_FAMILY_ADMISSION_RESERVATIONS_KEY,
    );
    const presentAgentIds = new Set(state.agents.map((agent) => agent.id));
    const normalized = normalizeSettlementFamilyAdmissionReservations(stored, presentAgentIds, now);
    const next = upsertSettlementFamilyAdmissionReservation(
      normalized.reservations,
      {
        reservationId,
        sourceRegionId,
        pioneerId,
        factionId,
        agentIds,
        expiresAtMs: now + SETTLEMENT_FAMILY_ADMISSION_RESERVATION_TTL_MS,
      },
    );
    await this.autonomyState.storage.put(SETTLEMENT_FAMILY_ADMISSION_RESERVATIONS_KEY, next);
  });
}

  private async registerSettlementFamilyFollow(request: Request): Promise<Response> {
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
      || (body.maxFollowers !== undefined && (typeof body.maxFollowers !== "number" || !Number.isInteger(body.maxFollowers) || body.maxFollowers < 0))
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
      body.maxFollowers,
    );
    if (result.agentIds.length > 0) this.replaceRuntimeState(state);
    if (settlementFamilyRegistrationDeferred(result)) {
      return new Response(JSON.stringify({
        error: "settlement family admission deferred",
        targetRegionId: body.targetRegionId,
        registeredAgentIds: result.agentIds,
        candidateCount: result.candidateCount,
      }), {
        status: 409,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
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
const familyReservations = await this.activeSettlementFamilyAdmissionReservations(state);
const familyAdmissionHeadroom = Math.max(
  0,
  settlementFamilyAdmissionHeadroom(state, pioneer.factionId)
    - settlementFamilyReservedSlots(familyReservations, pioneer.factionId),
);

      if (familyAdmissionHeadroom <= 0) continue;
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
              maxFollowers: familyAdmissionHeadroom,
              ...(pioneer.pregnancy?.partnerId === undefined
                ? {}
                : { pioneerPartnerId: pioneer.pregnancy.partnerId }),
            }),
          },
        ));
let payload: unknown;
try {
  payload = await response.clone().json();
} catch {
  payload = undefined;
}
const registeredAgentIds = isRecord(payload) && Array.isArray(payload.registeredAgentIds)
  ? payload.registeredAgentIds.filter((agentId): agentId is string => typeof agentId === "string")
  : [];
if (registeredAgentIds.length > 0) {
  await this.reserveSettlementFamilyAdmissions(
    state,
    sourceRegionId,
    pioneer.id,
    pioneer.factionId,
    registeredAgentIds,
  );
}
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
    const continuingGather =
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
    }
    const destinationReservations = await this.activeDestinationStorageReservations();
    const destinationStorageReserved = destinationReservations.some((entry) =>
      entry.claimId === body.claimId && entry.sourceRegionId === body.sourceRegionId
    );
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
      ...(existing?.returnStorageLeaseRenewedAtMs === undefined
        ? {}
        : { returnStorageLeaseRenewedAtMs: existing.returnStorageLeaseRenewedAtMs }),
      destinationStorageReserved: existing?.destinationStorageReserved ?? destinationStorageReserved,
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
        returnStorageReserved: false,
      }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const previousSettled = claim.settledAmount ?? 0;
    const settledAmount = Math.max(previousSettled, body.settledAmount);
    const newlySettled = Math.max(0, settledAmount - previousSettled);
    const remainingAmount = Math.max(0, claim.amount - newlySettled);
    const keepReturnStorageReservation =
      claim.returnToSourceStorage === true
      && (claim.returnStorageAmount ?? claim.amount) > 0;
    const nowMs = Date.now();
    const shouldRenewReturnStorageLease =
      keepReturnStorageReservation
      && (
        claim.returnStorageLeaseExpiresAtMs === undefined
        || claim.returnStorageLeaseExpiresAtMs
          <= nowMs + RETURN_STORAGE_RESERVATION_TTL_MS - RETURN_STORAGE_RENEW_INTERVAL_MS
      );
    const next = remainingAmount > 0 || keepReturnStorageReservation
      ? claims.map((entry) => entry.claimId === claim.claimId
        ? {
            ...entry,
            amount: remainingAmount,
            settledAmount,
            ...(keepReturnStorageReservation
              ? {
                  returnStorageAmount: claim.returnStorageAmount ?? claim.amount,
                  returnStorageLeaseExpiresAtMs: shouldRenewReturnStorageLease
                    ? nowMs + RETURN_STORAGE_RESERVATION_TTL_MS
                    : claim.returnStorageLeaseExpiresAtMs,
                  expiresAtTick: Math.max(claim.expiresAtTick, tick + AUTONOMOUS_SUPPLY_CLAIM_TTL),
                }
              : {}),
          }
        : entry)
      : claims.filter((entry) => entry.claimId !== claim.claimId);
    await this.autonomyState.storage.put(AUTONOMOUS_SUPPLY_CLAIMS_KEY, next);
    return new Response(JSON.stringify({
      ok: true,
      claimId: claim.claimId,
      settledAmount,
      remainingAmount,
      returnStorageReserved: keepReturnStorageReservation,
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
    const sourceRegionId = pending.claimSourceRegionId ?? runtimeAccess(this).runtime.snapshot().regionId;
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
      let returnStorageLeaseRenewedAtMs = claim.returnStorageLeaseRenewedAtMs;
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
            if (claim.returnToSourceStorage === true) {
              returnStorageLeaseRenewedAtMs = Date.now();
            }
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
        ...(returnStorageLeaseRenewedAtMs === undefined
          ? {}
          : { returnStorageLeaseRenewedAtMs }),
      };
      const returnCargoOutstanding =
        updatedClaim.returnToSourceStorage === true
        && agent !== undefined
        && agent.inventory[updatedClaim.resource] > 0;
      const now = Date.now();
      if (
        returnCargoOutstanding
        && now - (updatedClaim.returnStorageLeaseRenewedAtMs ?? 0) >= RETURN_STORAGE_RENEW_INTERVAL_MS
      ) {
        try {
          const response = await this.autonomyStub(updatedClaim.sourceRegionId).fetch(new Request(
            `https://moyo.internal${INTERNAL_CLAIM_SETTLE_PATH}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-moyo-region-internal": updatedClaim.sourceRegionId,
              },
              body: JSON.stringify({ claimId: updatedClaim.claimId, settledAmount }),
            },
          ));
          if (response.ok) {
            const payload = await response.json() as unknown;
            if (isRecord(payload) && payload.returnStorageReserved === true) {
              updatedClaim.returnStorageLeaseRenewedAtMs = now;
              dirty = true;
            }
          }
        } catch {
          // Keep the arrival claim and physical cargo. The existing bounded source
          // lease remains the crash-safe fallback and the next cadence retries.
        }
      }
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

        // A blocked seam is a physical routing problem, not evidence that the
        // original storage claim can be forgotten. Keep the ultimate owner while
        // cargo is still on the BOT so later terrain/state changes can replan it.
        if (
          updatedClaim.returnToSourceStorage === true &&
          claim.sourceRegionId !== after.regionId &&
          pendingReturn === undefined &&
          (existingHandoff === undefined || existingHandoff === null) &&
          inventoryAmount(agent) > 0
        ) {
          agent.status = `return route to ${claim.sourceRegionId} unavailable; waiting to replan`;
          keep.push(updatedClaim);
          this.replaceRuntimeState(after);
          dirty = true;
          continue;
        }
      }

      if (stillGathering) {
        keep.push(updatedClaim);
        continue;
      }

      // Gathering settles supply ownership, not the physical sink. Keep
      // source storage promised until cargo actually leaves the courier.
      if (returnCargoOutstanding) {
        keep.push(updatedClaim);
        continue;
      }

      // Keep admitted sink capacity until gathered cargo leaves this BOT.
      // Releasing at gather completion can overbook storage before deposit commits.
      const destinationCargoOutstanding =
        updatedClaim.destinationStorageReserved === true
        && gatheredAmount > 0
        && agent !== undefined
        && agent.inventory[updatedClaim.resource] > 0;
      if (destinationCargoOutstanding) {
        keep.push(updatedClaim);
        continue;
      }
      if (updatedClaim.destinationStorageReserved === true) {
        await this.releaseDestinationStorageReservation(
          updatedClaim.claimId,
          updatedClaim.sourceRegionId,
        );
        dirty = true;
      }

      if (reservationExhausted && updatedClaim.returnToSourceStorage !== true) {
        dirty = true;
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
    const failedSettlementFamilyFollow =
      pending.settlementFamilyFollow === true
      && agent?.task?.source === "autonomy"
      && agent.task.type === "move";
    const failedTradeHandoff =
      pending.tradeTargetAgentId !== undefined
      && agent?.task?.source === "autonomy"
      && agent.task.type === "trade"
      && agent.task.targetAgentId === pending.tradeTargetAgentId;
    if (failedTradeHandoff && agent?.task?.type === "trade") {
      delete agent.task.routeRegionId;
      delete agent.task.routeTarget;
      agent.status = `trade handoff ${pending.direction} rejected; rediscovering counterparty`;
      this.replaceRuntimeState(state);
    }
    if (failedResourceHandoff || failedSettlementMigration || failedSettlementFamilyFollow) {
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
    const claims = await this.activeAutonomousSupplyClaims(state.tick);

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

      const claim = pending.claimId === undefined
        ? undefined
        : claims.find((entry) => entry.claimId === pending.claimId);
      if (claim?.destinationStorageReserved === true) {
        const factionId = claim.sourceFactionId ?? agent.factionId;
        const renewedAmount = await this.reserveRemoteDestinationStorage(
          state,
          claim.claimId,
          claim.neighborRegionId,
          factionId,
          claim.amount,
        );
        if (renewedAmount < claim.amount) {
          if (isMatchingTravelTask(agent, pending)) {
            delete agent.task;
          }
          agent.status = `remote storage lease lost; replanning ${pending.resource}`;
          stateDirty = true;
          await this.releaseAutonomousSupplyClaim(pending.claimId);
          continue;
        }
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

  private async reserveRemoteDestinationStorage(
    state: WorldState,
    claimId: string,
    neighborRegionId: string,
    factionId: string,
    amount: number,
  ): Promise<number> {
    try {
      const response = await this.autonomyStub(neighborRegionId).fetch(new Request(
        `https://moyo.internal${INTERNAL_STORAGE_RESERVE_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-moyo-region-internal": neighborRegionId,
          },
          body: JSON.stringify({
            claimId,
            sourceRegionId: state.regionId,
            factionId,
            amount,
          }),
        },
      ));
      if (!response.ok) return 0;
      const payload = await response.json() as unknown;
      if (!isRecord(payload) || typeof payload.grantedAmount !== "number") return 0;
      if (!Number.isFinite(payload.grantedAmount) || payload.grantedAmount <= 0) return 0;
      return Math.min(amount, payload.grantedAmount);
    } catch {
      // A known remote-only sink must fail closed if its actual destination
      // admission cannot be confirmed. The next scout cadence can retry.
      return 0;
    }
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
      const plannedSupply = plan.claimedSupply ?? 0;
      const sourceStorageHeadroom = factionStorageCapacityLeft(state, agent.factionId);
      const reservedReturnStorage = reservedReturnStorageForFaction(
        state,
        workingClaims,
        agent.factionId,
      );
      const availableReturnStorage = Math.max(0, sourceStorageHeadroom - reservedReturnStorage);
      const returnToSourceStorage = availableReturnStorage > 0;
      const needsDestinationReservation =
        !returnToSourceStorage
        && plan.destinationStorageHeadroom !== undefined
        && plan.destinationStorageHeadroom > 0;
      let destinationStorageReserved = false;
      // Source-return capacity remains a local promise. If this expedition
      // depends on a concrete remote sink, ask the destination DO to admit the
      // claim against current storage plus reservations from every source DO.
      let claimedSupply = returnToSourceStorage
        ? Math.min(plannedSupply, availableReturnStorage)
        : plannedSupply;
      if (needsDestinationReservation) {
        const requestedRemoteStorage = Math.min(
          plannedSupply,
          plan.destinationStorageHeadroom ?? plannedSupply,
        );
        claimedSupply = await this.reserveRemoteDestinationStorage(
          state,
          claimId,
          plan.neighborRegionId,
          agent.factionId,
          requestedRemoteStorage,
        );
        destinationStorageReserved = claimedSupply > 0;
        if (!destinationStorageReserved) break;
      }
      const pendingPlan: PendingAutonomousTravel = {
        ...plan,
        claimId,
        claimedSupply,
      };
      if (claimedSupply > 0) {
        workingClaims.push({
          claimId,
          agentId: plan.agentId,
          resource: plan.resource,
          direction: plan.direction,
          neighborRegionId: plan.neighborRegionId,
          amount: claimedSupply,
          expiresAtTick: state.tick + AUTONOMOUS_SUPPLY_CLAIM_TTL,
          sourceFactionId: agent.factionId,
          returnToSourceStorage,
          ...(returnToSourceStorage
            ? {
                returnStorageAmount: claimedSupply,
                returnStorageLeaseExpiresAtMs: Date.now() + RETURN_STORAGE_RESERVATION_TTL_MS,
              }
            : {}),
          ...(destinationStorageReserved ? { destinationStorageReserved: true } : {}),
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

  private tradeRoutingLinks(state: WorldState): HexHaloLink[] {
    return autonomyHaloLinksForActivity(
      state,
      configuredRegionIds(this.autonomyEnv),
      state.regionId,
      this.activityTier(),
    );
  }

  private async localTradeCounterpartyLookup(
  agentId: string,
): Promise<TradeCounterpartyLookup> {
  const state = runtimeAccess(this).runtime.snapshot();
  if (state.agents.some((entry) => entry.id === agentId)) return { present: true };

  const stored = await this.autonomyState.storage.get<unknown>(OUTGOING_HANDOFF_KEY);
  const records = Array.isArray(stored)
    ? stored
      .flatMap((value) => {
        const record = tradeDirectoryRecord(value);
        return record?.globalAgentId === agentId ? [record] : [];
      })
      .sort((a, b) =>
        b.updatedAtTick - a.updatedAtTick
        || b.createdAtTick - a.createdAtTick
        || b.transferId.localeCompare(a.transferId)
      )
    : [];
  const latest = records[0];
  if (latest === undefined) return { present: false };
  if (latest.phase !== "committed") {
    return { present: false, handoffPending: true };
  }
  return { present: false, forwardedRegionId: latest.toRegionId };
}

private async tradeCounterpartyLookup(
  regionId: string,
  agentId: string,
): Promise<TradeCounterpartyLookup | undefined> {
  if (runtimeAccess(this).runtime.snapshot().regionId === regionId) {
    return this.localTradeCounterpartyLookup(agentId);
  }
  try {
    const response = await this.autonomyStub(regionId).fetch(new Request(
      `https://moyo.internal${INTERNAL_AGENT_LOOKUP_PATH}?agentId=${encodeURIComponent(agentId)}`,
      { headers: { "x-moyo-region-internal": regionId } },
    ));
    if (!response.ok) return undefined;
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || typeof payload.present !== "boolean") return undefined;
    return {
      present: payload.present,
      ...(typeof payload.forwardedRegionId === "string"
        ? { forwardedRegionId: payload.forwardedRegionId }
        : {}),
      ...(payload.handoffPending === true ? { handoffPending: true } : {}),
    };
  } catch {
    return undefined;
  }
}

private async resolveTradeCounterpartyOwner(
  agentId: string,
): Promise<{
  ownerRegionId?: string;
  status: "found" | "not_found" | "unavailable" | "cycle" | "hop_limit";
}> {
  const originRegionId = globalTradeOriginRegionId(agentId);
  if (originRegionId === undefined) return { status: "not_found" };

  let regionId = originRegionId;
  const visited = new Set<string>();
  for (let hop = 0; hop <= AUTONOMOUS_TRADE_MAX_DIRECTORY_HOPS; hop += 1) {
    if (visited.has(regionId)) return { status: "cycle" };
    visited.add(regionId);
    const lookup = await this.tradeCounterpartyLookup(regionId, agentId);
    if (lookup === undefined || lookup.handoffPending === true) {
      return { status: "unavailable" };
    }
    if (lookup.present) return { ownerRegionId: regionId, status: "found" };
    if (lookup.forwardedRegionId === undefined) return { status: "not_found" };
    if (hop === AUTONOMOUS_TRADE_MAX_DIRECTORY_HOPS) return { status: "hop_limit" };
    regionId = lookup.forwardedRegionId;
  }
  return { status: "hop_limit" };
}

private async resumeOrPlanAutonomousTradeHandoff(state: WorldState): Promise<boolean> {
  const agent = [...state.agents]
    .sort((a, b) => a.id.localeCompare(b.id))
    .find((entry) => {
      const task = entry.task;
      return entry.autonomy
        && task?.source === "autonomy"
        && task.type === "trade"
        && task.targetAgentId.startsWith("agent-global:")
        && state.tick - task.issuedAtTick <= AUTONOMOUS_TRADE_DISCOVERY_TTL
        && !state.agents.some((candidate) => candidate.id === task.targetAgentId);
    });
  const task = agent?.task;
  if (
    agent === undefined
    || task?.source !== "autonomy"
    || task.type !== "trade"
  ) return false;

  // Directory reads are bounded but still cross Durable Objects. Once a
  // route owner is known, local movement continues without another lookup
  // until the trader reaches the seam and performs its preflight refresh.
  if (task.routeRegionId === undefined && state.tick % AUTONOMOUS_SCOUT_INTERVAL !== 0) {
    return false;
  }

  const links = this.tradeRoutingLinks(state);
  let targetRegionId = task.routeRegionId;
  if (targetRegionId === undefined) {
    const resolution = await this.resolveTradeCounterpartyOwner(task.targetAgentId);
    targetRegionId = resolution.ownerRegionId;
    if (targetRegionId === undefined) {
      agent.status = resolution.status === "unavailable"
        ? `trade counterparty lookup unavailable; retrying ${task.targetAgentId}`
        : resolution.status === "hop_limit"
          ? `trade counterparty directory exceeded bounded lookup; waiting ${task.targetAgentId}`
          : resolution.status === "cycle"
            ? `trade counterparty directory cycle detected; waiting ${task.targetAgentId}`
            : `trade counterparty ${task.targetAgentId} has no current owner record`;
      this.replaceRuntimeState(state);
      return true;
    }
  }

  const sourceAxial = regionAxialCoordinate(state.regionId);
  const targetAxial = regionAxialCoordinate(targetRegionId);
  if (sourceAxial === undefined || targetAxial === undefined) {
    delete task.routeRegionId;
    delete task.routeTarget;
    agent.status = `trade owner ${targetRegionId} has no hex route; waiting`;
    this.replaceRuntimeState(state);
    return true;
  }
  const routeDistance = hexDistance(sourceAxial, targetAxial);
  if (routeDistance <= 0 || routeDistance > AUTONOMOUS_TRADE_MAX_ROUTE_HOPS) {
    delete task.routeRegionId;
    delete task.routeTarget;
    agent.status = routeDistance > AUTONOMOUS_TRADE_MAX_ROUTE_HOPS
      ? `trade owner ${targetRegionId} is outside bounded ${AUTONOMOUS_TRADE_MAX_ROUTE_HOPS}-hop route`
      : `trade owner directory for ${task.targetAgentId} is stale; replanning`;
    this.replaceRuntimeState(state);
    return true;
  }
  const relayHopsNeeded = Math.max(0, routeDistance - 1);
  if (task.handoffRetryBudget === undefined && relayHopsNeeded > 0) {
    task.handoffRetryBudget = relayHopsNeeded;
  } else if (
    task.handoffRetryBudget !== undefined
    && relayHopsNeeded > task.handoffRetryBudget
  ) {
    delete agent.task;
    agent.status = `trade route to ${task.targetAgentId} exceeded remaining handoff budget`;
    this.replaceRuntimeState(state);
    return true;
  }

  const route = planAutonomousTradeNeighborRoute(state, links, agent.id, targetRegionId);
  if (route === undefined) {
    delete task.routeRegionId;
    delete task.routeTarget;
    agent.status = `no passable route toward trade counterparty ${task.targetAgentId}`;
    this.replaceRuntimeState(state);
    return true;
  }
  // Keep the final owner as the persistent hint. The route helper chooses
  // the immediate neighbor that shortens hex distance by exactly one.
  task.routeRegionId = targetRegionId;
  task.routeTarget = { ...route.boundaryTarget };

  if (!samePosition(agent.position, route.boundaryTarget)) {
    agent.status = route.neighborRegionId === targetRegionId
      ? `traveling toward ${targetRegionId} to trade with ${task.targetAgentId}`
      : `traveling via ${route.neighborRegionId} toward ${targetRegionId} to trade with ${task.targetAgentId}`;
    this.replaceRuntimeState(state);
    return true;
  }

  const transition = regionCellTransition(
    state.regionId,
    route.desiredPosition,
    state.width,
    state.height,
  );
  if (transition?.targetRegionId !== route.neighborRegionId) {
    delete task.routeRegionId;
    delete task.routeTarget;
    agent.status = `trade route to ${task.targetAgentId} changed; replanning`;
    this.replaceRuntimeState(state);
    return true;
  }

  // Refresh the owner directory immediately before detach. A target may
  // move through several regions while the trader walks to this seam;
  // never hand off using an owner hint that is already known to be stale.
  const refreshed = await this.resolveTradeCounterpartyOwner(task.targetAgentId);
  if (refreshed.status !== "found" || refreshed.ownerRegionId === undefined) {
    if (refreshed.status !== "unavailable") {
      delete task.routeRegionId;
      delete task.routeTarget;
    }
    agent.status = refreshed.status === "unavailable"
      ? `trade counterparty lookup unavailable at seam; waiting`
      : `trade counterparty ${task.targetAgentId} owner unresolved; replanning`;
    this.replaceRuntimeState(state);
    return true;
  }
  if (refreshed.ownerRegionId !== targetRegionId) {
    delete task.routeRegionId;
    delete task.routeTarget;
    agent.status = `trade counterparty ${task.targetAgentId} moved to ${refreshed.ownerRegionId}; replanning`;
    this.replaceRuntimeState(state);
    return true;
  }

  const pending: PendingAutonomousHandoff = {
    transferId: `trade:${state.regionId}:${agent.id}:${task.issuedAtTick}:${route.direction}`,
    agentId: agent.id,
    direction: route.direction,
    resource: undefined,
    desiredPosition: { ...route.desiredPosition },
    tradeTargetAgentId: task.targetAgentId,
  };
  await this.autonomyState.storage.put(AUTONOMOUS_HANDOFF_KEY, pending);
  await this.attemptPendingHandoff(pending);
  return true;
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
    await this.notifySettledPioneers(state);
    if (await this.resumeOrPlanAutonomousTradeHandoff(state)) return;
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
    let halo: HexHaloTile[] = [];
    if (loadedDirections.length > 0) {
      halo = await this.materializeAutonomyHalo(state, loadedDirections);
      if (familyFollowDue && await this.advanceSettlementFamilyFollow(state, halo)) return;
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

  private async fetchReservationAwareHaloEdge(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    if (!response.ok || request.method !== "GET") return response;

    let payload: unknown;
    try {
      payload = await response.clone().json();
    } catch {
      return response;
    }
    if (!isRecord(payload) || !isRecord(payload.regionSummary)) return response;
    const summary = payload.regionSummary;
    if (!isRecord(summary.storageHeadroomByFaction)) return response;

    const reservations = await this.activeDestinationStorageReservations();
    if (reservations.length === 0) return response;
    const reservedByFaction = new Map<string, number>();
    for (const reservation of reservations) {
      reservedByFaction.set(
        reservation.factionId,
        (reservedByFaction.get(reservation.factionId) ?? 0) + reservation.amount,
      );
    }
    const storageHeadroomByFaction = { ...summary.storageHeadroomByFaction };
    for (const [factionId, reserved] of reservedByFaction) {
      const observed = storageHeadroomByFaction[factionId];
      if (typeof observed !== "number" || !Number.isFinite(observed) || observed < 0) continue;
      storageHeadroomByFaction[factionId] = Math.max(0, observed - reserved);
    }

    return new Response(JSON.stringify({
      ...payload,
      regionSummary: {
        ...summary,
        storageHeadroomByFaction,
      },
    }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(INTERNAL_AUTONOMY_PREFIX)) {
      return ["GET", "HEAD", "OPTIONS"].includes(request.method)
        ? this.fetchAutonomyRequest(request)
        : this.withHaloEdgeMutation(() => this.fetchAutonomyRequest(request));
    }
    if (request.method === "GET" && url.pathname === INTERNAL_EDGE_PATH) {
      return this.fetchReservationAwareHaloEdge(request);
    }
    return super.fetch(request);
  }

  private async fetchAutonomyRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const assignmentError = await this.ensureAutonomyAssigned(request);
    if (assignmentError !== undefined) return assignmentError;
    if (request.method === "GET" && url.pathname === INTERNAL_AGENT_LOOKUP_PATH) {
      const agentId = url.searchParams.get("agentId");
      if (agentId === null || agentId.length > 192 || !agentId.startsWith("agent-global:")) {
        return new Response(JSON.stringify({ error: "agentId must be a world-global agent ID" }), { status: 400 });
      }
      const lookup = await this.localTradeCounterpartyLookup(agentId);
      return new Response(JSON.stringify({ agentId, ...lookup }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (request.method === "POST" && url.pathname === INTERNAL_STORAGE_RESERVE_PATH) {
      return this.reserveDestinationStorage(request);
    }
    if (request.method === "POST" && url.pathname === INTERNAL_STORAGE_RELEASE_PATH) {
      return this.releaseDestinationStorage(request);
    }
    if (request.method === "POST" && url.pathname === INTERNAL_SETTLEMENT_FAMILY_REGISTER_PATH) {
      return this.registerSettlementFamilyFollow(request);
    }
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
    const batchStartedAt = now;
    const ownsEdgeReadBatch = this.beginHaloEdgeReadBatch();
    let completed = false;
    let slowestTickMs = 0;
    try {
      for (let index = 0; index < ticks; index += 1) {
        // Reserve the slowest duration already observed in this batch before
        // starting another historical tick. This cannot cap one unexpectedly
        // slow tick, but it avoids knowingly compounding the overrun.
        const elapsedBeforeTick = Math.max(0, Date.now() - batchStartedAt);
        if (
          index > 0
          && elapsedBeforeTick + slowestTickMs >= CATCH_UP_WALL_BUDGET_MS
        ) {
          break;
        }
        this.setAlarmRescheduleDeferred(index + 1 < ticks);
        const tickStartedAt = Date.now();
        await this.runSingleAlarmTick();
        slowestTickMs = Math.max(
          slowestTickMs,
          Math.max(0, Date.now() - tickStartedAt),
        );
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
