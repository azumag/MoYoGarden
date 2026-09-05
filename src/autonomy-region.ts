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
import type { Agent, ResourceKind, WorldState } from "./protocol.js";
import { WorldRuntime } from "./runtime.js";

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
}

export interface AutonomousHaloHandoffPlan extends PendingAutonomousHandoff {
  neighborRegionId: string;
}

const AUTONOMOUS_HANDOFF_KEY = "handoff:autonomy:v1";
const INTERNAL_EDGE_PATH = "/api/internal/halo/edge";
const LOW_ENERGY_THRESHOLD = 18;

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

export function planAutonomousHaloHandoff(
  state: WorldState,
  halo: readonly HexHaloTile[],
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
        entry.tile.resource.amount > 0
      )
      .sort((a, b) =>
        directionRank(a.direction) - directionRank(b.direction) ||
        a.neighborRegionId.localeCompare(b.neighborRegionId)
      )[0];
    if (candidate === undefined) continue;

    const issuedAtTick = agent.task?.source === "autonomy" && agent.task.type === "gather"
      ? agent.task.issuedAtTick
      : state.tick;
    return {
      transferId: `autonomy:${state.regionId}:${agent.id}:${issuedAtTick}:${candidate.direction}`,
      agentId: agent.id,
      direction: candidate.direction,
      resource,
      neighborRegionId: candidate.neighborRegionId,
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

  private autonomousHandoffRequest(pending: PendingAutonomousHandoff): Request {
    return new Request("http://localhost/api/admin/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transferId: pending.transferId,
        agentId: pending.agentId,
        direction: pending.direction,
      }),
    });
  }

  private async attemptPendingHandoff(pending: PendingAutonomousHandoff): Promise<void> {
    const response = await super.fetch(this.autonomousHandoffRequest(pending));
    if (response.ok || response.status < 500) {
      await this.autonomyState.storage.put(AUTONOMOUS_HANDOFF_KEY, null);
    }
  }

  private async resumeOrPlanAutonomousHandoff(state: WorldState): Promise<void> {
    const pending = await this.autonomyState.storage.get<PendingAutonomousHandoff | null>(AUTONOMOUS_HANDOFF_KEY);
    if (pending !== undefined && pending !== null) {
      await this.attemptPendingHandoff(pending);
      return;
    }
    const directions = autonomyHaloPlanningDirections(state);
    if (directions.length === 0) return;

    const halo = await this.materializeAutonomyHalo(state, directions);
    const plan = planAutonomousHaloHandoff(state, halo);
    if (plan === undefined) return;

    const pendingPlan: PendingAutonomousHandoff = {
      transferId: plan.transferId,
      agentId: plan.agentId,
      direction: plan.direction,
      resource: plan.resource,
    };
    await this.autonomyState.storage.put(AUTONOMOUS_HANDOFF_KEY, pendingPlan);
    await this.attemptPendingHandoff(pendingPlan);
  }

  override async alarm(): Promise<void> {
    const before = runtimeAccess(this).runtime.snapshot();
    await this.resumeOrPlanAutonomousHandoff(before);
    await super.alarm();
  }
}
