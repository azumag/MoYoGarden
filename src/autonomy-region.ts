import {
  buildHexHaloLinks,
  materializeHexHalo,
  type HexHaloEdgeSnapshot,
  type HexHaloTile,
} from "./hex-halo.js";
import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  isHexGridCell,
  oppositeHexGridDirection,
  type HexGridDirection,
} from "./hex-grid.js";
import { RegionDurableObject as HaloRegionDurableObject } from "./halo-region.js";
import {
  positionKey,
  type Agent,
  type GridPosition,
  type ResourceKind,
  type WorldState,
} from "./protocol.js";
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
  resource: ResourceKind;
  claimId?: string;
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
  expiresAtTick: number;
}

interface AutonomousArrivalClaim {
  claimId: string;
  sourceRegionId: string;
  agentId: string;
  resource: ResourceKind;
  registeredAtTick: number;
}

export interface AutonomousHaloHandoffPlan extends PendingAutonomousHandoff {
  neighborRegionId: string;
}

export interface AutonomousHaloTravelPlan extends PendingAutonomousTravel {}

const AUTONOMOUS_HANDOFF_KEY = "handoff:autonomy:v1";
const AUTONOMOUS_TRAVEL_KEY = "handoff:autonomy:travel:v1";
const AUTONOMOUS_SUPPLY_CLAIMS_KEY = "handoff:autonomy:claims:v1";
const AUTONOMOUS_ARRIVAL_CLAIMS_KEY = "handoff:autonomy:arrival-claims:v1";
const INTERNAL_EDGE_PATH = "/api/internal/halo/edge";
const INTERNAL_AUTONOMY_PREFIX = "/api/internal/autonomy/";
const INTERNAL_CLAIM_REGISTER_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/register`;
const INTERNAL_CLAIM_RELEASE_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/release`;
const LOW_ENERGY_THRESHOLD = 18;
const AUTONOMOUS_SCOUT_INTERVAL = 12;
const AUTONOMOUS_TRAVEL_TTL = 48;
const AUTONOMOUS_SUPPLY_CLAIM_TTL = AUTONOMOUS_TRAVEL_TTL + AUTONOMOUS_SCOUT_INTERVAL;

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
    && typeof value.expiresAtTick === "number"
    && Number.isInteger(value.expiresAtTick);
}

function isAutonomousArrivalClaim(value: unknown): value is AutonomousArrivalClaim {
  return isRecord(value)
    && typeof value.claimId === "string"
    && typeof value.sourceRegionId === "string"
    && typeof value.agentId === "string"
    && isResourceKind(value.resource)
    && Number.isInteger(value.registeredAtTick);
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
  if (agent.task !== undefined) {
    return agent.task.source === "autonomy" && agent.task.type === "gather"
      ? agent.task.resource
      : undefined;
  }
  if (agent.energy <= LOW_ENERGY_THRESHOLD) return undefined;
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

function haloSupplyKey(direction: HexGridDirection, neighborRegionId: string): string {
  return `${direction}:${neighborRegionId}`;
}

function availableHaloSupplyForAgent(
  state: Pick<WorldState, "tick">,
  halo: readonly HexHaloTile[],
  claims: readonly AutonomousSupplyClaim[],
  agentId: string,
  resource: ResourceKind,
  direction: HexGridDirection,
  neighborRegionId: string,
): number {
  let visibleSupply = 0;
  for (const entry of halo) {
    if (
      entry.direction !== direction ||
      entry.neighborRegionId !== neighborRegionId ||
      entry.tile.terrain === "water" ||
      entry.tile.resource?.kind !== resource ||
      entry.tile.resource.amount <= 0
    ) {
      continue;
    }
    visibleSupply += entry.tile.resource.amount;
  }

  let claimedSupply = 0;
  for (const claim of claims) {
    if (
      claim.resource !== resource ||
      claim.direction !== direction ||
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
    const visibleSupply = new Map<string, number>();
    for (const { entry } of candidates) {
      const key = haloSupplyKey(entry.direction, entry.neighborRegionId);
      visibleSupply.set(key, (visibleSupply.get(key) ?? 0) + (entry.tile.resource?.amount ?? 0));
    }
    const claimedSupply = new Map<string, number>();
    for (const claim of claims) {
      if (claim.resource !== resource || claim.expiresAtTick <= state.tick) continue;
      const key = haloSupplyKey(claim.direction, claim.neighborRegionId);
      claimedSupply.set(key, (claimedSupply.get(key) ?? 0) + claim.amount);
    }

    const candidate = candidates
      .flatMap(({ entry, travelDistance }) => {
        const key = haloSupplyKey(entry.direction, entry.neighborRegionId);
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
          entry.direction,
          entry.neighborRegionId,
        ) > 0
      )
      .sort((a, b) =>
        directionRank(a.direction) - directionRank(b.direction) ||
        a.neighborRegionId.localeCompare(b.neighborRegionId)
      )[0];
    if (candidate === undefined) continue;

    const issuedAtTick = agent.task?.source === "autonomy" && agent.task.type === "gather"
      ? agent.task.issuedAtTick
      : state.tick;
    const claimId = claims
      .filter((claim) =>
        claim.agentId === agent.id &&
        claim.resource === resource &&
        claim.direction === candidate.direction &&
        claim.neighborRegionId === candidate.neighborRegionId &&
        claim.expiresAtTick > state.tick
      )
      .sort((a, b) =>
        b.expiresAtTick - a.expiresAtTick || b.claimId.localeCompare(a.claimId)
      )[0]?.claimId;
    return {
      transferId: `autonomy:${state.regionId}:${agent.id}:${issuedAtTick}:${candidate.direction}`,
      agentId: agent.id,
      direction: candidate.direction,
      resource,
      neighborRegionId: candidate.neighborRegionId,
      ...(claimId === undefined ? {} : { claimId }),
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
    return this.autonomyEnv.REGIONS.get(this.autonomyEnv.REGIONS.idFromName(regionId));
  }

  private async fetchAutonomyNeighborEdge(
    neighborRegionId: string,
    direction: HexGridDirection,
  ): Promise<HexHaloEdgeSnapshot | undefined> {
    const url = new URL(`https://moyo.internal${INTERNAL_EDGE_PATH}`);
    url.searchParams.set("direction", direction);
    const response = await this.autonomyStub(neighborRegionId).fetch(new Request(url, {
      method: "GET",
      headers: { "x-moyo-region-internal": neighborRegionId },
    }));
    if (!response.ok) return undefined;
    const value = await response.json() as unknown;
    return isEdgeSnapshot(value) ? value : undefined;
  }

  private async materializeAutonomyHalo(
    state: WorldState,
    directions: readonly HexGridDirection[],
  ): Promise<HexHaloTile[]> {
    const needed = new Set(directions);
    const links = buildHexHaloLinks(state, configuredRegionIds(this.autonomyEnv), state.regionId)
      .filter((link) => needed.has(link.direction));
    const requested = new Map<string, { regionId: string; direction: HexGridDirection }>();
    for (const link of links) {
      const direction = oppositeHexGridDirection(link.direction);
      requested.set(`${link.neighborRegionId}:${direction}`, {
        regionId: link.neighborRegionId,
        direction,
      });
    }
    const edges = (
      await Promise.all(
        [...requested.values()].map(({ regionId, direction }) =>
          this.fetchAutonomyNeighborEdge(regionId, direction)
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

  private async persistAutonomousSupplyClaim(claim: AutonomousSupplyClaim, tick: number): Promise<void> {
    const active = await this.activeAutonomousSupplyClaims(tick);
    await this.autonomyState.storage.put(
      AUTONOMOUS_SUPPLY_CLAIMS_KEY,
      [...active.filter((entry) => entry.claimId !== claim.claimId), claim],
    );
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
      !configuredRegionIds(this.autonomyEnv).includes(body.sourceRegionId) ||
      typeof body.agentId !== "string" ||
      body.agentId.trim() === "" ||
      !isResourceKind(body.resource)
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
    const claim: AutonomousArrivalClaim = {
      claimId: body.claimId,
      sourceRegionId: body.sourceRegionId,
      agentId: body.agentId,
      resource: body.resource,
      registeredAtTick: state.tick,
    };
    const claims = await this.arrivalClaims();
    await this.autonomyState.storage.put(
      AUTONOMOUS_ARRIVAL_CLAIMS_KEY,
      [...claims.filter((entry) => entry.claimId !== claim.claimId), claim],
    );
    return new Response(JSON.stringify({ ok: true, claimId: claim.claimId }), {
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
        }),
      }));
    } catch {
      // The source-side TTL remains the crash-safe fallback if arrival tracking
      // cannot be installed after the ownership handoff has already committed.
    }
  }

  private async reconcileArrivalClaims(after: WorldState): Promise<void> {
    const claims = await this.arrivalClaims();
    if (claims.length === 0) return;
    const keep: AutonomousArrivalClaim[] = [];
    for (const claim of claims) {
      const agent = after.agents.find((entry) => entry.id === claim.agentId);
      const stillGathering =
        agent?.autonomy === true &&
        agent.task?.source === "autonomy" &&
        agent.task.type === "gather" &&
        agent.task.resource === claim.resource;
      if (stillGathering) {
        keep.push(claim);
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
        if (!response.ok) keep.push(claim);
      } catch {
        keep.push(claim);
      }
    }
    if (keep.length !== claims.length) {
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
    if (
      agent?.task?.source === "autonomy" &&
      agent.task.type === "gather" &&
      agent.task.resource === pending.resource
    ) {
      delete agent.task;
      agent.status = `handoff ${pending.direction} rejected; replanning`;
      this.replaceRuntimeState(state);
    }
    await this.autonomyState.storage.put(AUTONOMOUS_HANDOFF_KEY, null);
  }

  private async resumeAutonomousTravel(state: WorldState): Promise<boolean> {
    const pending = await this.autonomyState.storage.get<PendingAutonomousTravel | null>(AUTONOMOUS_TRAVEL_KEY);
    if (pending === undefined || pending === null) return false;

    const agent = state.agents.find((entry) => entry.id === pending.agentId);
    if (agent === undefined || !agent.autonomy || agent.task?.source === "external") {
      await this.releaseAutonomousSupplyClaim(pending.claimId);
      await this.autonomyState.storage.put(AUTONOMOUS_TRAVEL_KEY, null);
      return false;
    }

    if (
      agent.energy <= LOW_ENERGY_THRESHOLD ||
      localResourceAvailable(state, pending.resource) ||
      state.tick - pending.startedAtTick > AUTONOMOUS_TRAVEL_TTL
    ) {
      if (isMatchingTravelTask(agent, pending)) delete agent.task;
      await this.releaseAutonomousSupplyClaim(pending.claimId);
      await this.autonomyState.storage.put(AUTONOMOUS_TRAVEL_KEY, null);
      this.replaceRuntimeState(state);
      return false;
    }

    if (samePosition(agent.position, pending.boundaryTarget)) {
      agent.task = {
        source: "autonomy",
        issuedAtTick: pending.issuedAtTick,
        type: "gather",
        resource: pending.resource,
      };
      agent.status = `scouting ${pending.neighborRegionId} for ${pending.resource}`;
      await this.autonomyState.storage.put(AUTONOMOUS_TRAVEL_KEY, null);
      this.replaceRuntimeState(state);
      return false;
    }

    if (!isMatchingTravelTask(agent, pending)) {
      agent.task = {
        source: "autonomy",
        issuedAtTick: pending.issuedAtTick,
        type: "move",
        target: { ...pending.boundaryTarget },
      };
      agent.status = `traveling toward ${pending.neighborRegionId} for ${pending.resource}`;
      this.replaceRuntimeState(state);
    }
    return true;
  }

  private async startAutonomousTravel(
    state: WorldState,
    cachedHalo: readonly HexHaloTile[] = [],
    cachedDirections: readonly HexGridDirection[] = [],
  ): Promise<boolean> {
    if (!shouldScoutAutonomyHalo(state)) return false;
    const loadedDirections = new Set(cachedDirections);
    const missingDirections = HEX_GRID_DIRECTIONS.filter((direction) => !loadedDirections.has(direction));
    const halo = missingDirections.length === 0
      ? [...cachedHalo]
      : [
          ...cachedHalo,
          ...(await this.materializeAutonomyHalo(state, missingDirections)),
        ];
    const claims = await this.activeAutonomousSupplyClaims(state.tick);
    const plan = planAutonomousHaloTravel(state, halo, claims);
    if (plan === undefined) return false;

    const agent = state.agents.find((entry) => entry.id === plan.agentId);
    if (agent === undefined) return false;
    const claimId = `autonomy-claim:${state.regionId}:${plan.agentId}:${state.tick}:${plan.direction}:${plan.neighborRegionId}`;
    const pendingPlan: PendingAutonomousTravel = {
      ...plan,
      claimId,
    };
    const claimedSupply = plan.claimedSupply ?? 0;
    if (claimedSupply > 0) {
      await this.persistAutonomousSupplyClaim({
        claimId,
        agentId: plan.agentId,
        resource: plan.resource,
        direction: plan.direction,
        neighborRegionId: plan.neighborRegionId,
        amount: claimedSupply,
        expiresAtTick: state.tick + AUTONOMOUS_SUPPLY_CLAIM_TTL,
      }, state.tick);
    }
    agent.task = {
      source: "autonomy",
      issuedAtTick: plan.issuedAtTick,
      type: "move",
      target: { ...plan.boundaryTarget },
    };
    agent.status = `traveling toward ${plan.neighborRegionId} for ${plan.resource}`;
    await this.autonomyState.storage.put(AUTONOMOUS_TRAVEL_KEY, pendingPlan);
    this.replaceRuntimeState(state);
    return true;
  }

  private async resumeOrPlanAutonomousHandoff(state: WorldState): Promise<void> {
    const pending = await this.autonomyState.storage.get<PendingAutonomousHandoff | null>(AUTONOMOUS_HANDOFF_KEY);
    if (pending !== undefined && pending !== null) {
      await this.attemptPendingHandoff(pending);
      return;
    }
    if (await this.resumeAutonomousTravel(state)) return;

    const directions = autonomyHaloPlanningDirections(state);
    let halo: HexHaloTile[] = [];
    if (directions.length > 0) {
      halo = await this.materializeAutonomyHalo(state, directions);
      const claims = await this.activeAutonomousSupplyClaims(state.tick);
      const plan = planAutonomousHaloHandoff(state, halo, claims);
      if (plan !== undefined) {
        const pendingPlan: PendingAutonomousHandoff = {
          transferId: plan.transferId,
          agentId: plan.agentId,
          direction: plan.direction,
          resource: plan.resource,
          ...(plan.claimId === undefined ? {} : { claimId: plan.claimId }),
        };
        await this.autonomyState.storage.put(AUTONOMOUS_HANDOFF_KEY, pendingPlan);
        await this.attemptPendingHandoff(pendingPlan);
        return;
      }
    }

    await this.startAutonomousTravel(state, halo, directions);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(INTERNAL_AUTONOMY_PREFIX)) {
      const assignmentError = await this.ensureAutonomyAssigned(request);
      if (assignmentError !== undefined) return assignmentError;
      if (request.method === "POST" && url.pathname === INTERNAL_CLAIM_REGISTER_PATH) {
        return this.registerArrivalClaim(request);
      }
      if (request.method === "POST" && url.pathname === INTERNAL_CLAIM_RELEASE_PATH) {
        return this.releaseArrivalSourceClaim(request);
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    return super.fetch(request);
  }

  override async alarm(): Promise<void> {
    const before = runtimeAccess(this).runtime.snapshot();
    await this.resumeOrPlanAutonomousHandoff(before);
    await super.alarm();
    await this.reconcileArrivalClaims(runtimeAccess(this).runtime.snapshot());
  }
}
