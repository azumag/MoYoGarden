import { RegionDurableObject as AutonomyRegionDurableObject } from "./autonomy-region.js";
import {
  buildConfiguredHexHaloLinks,
  buildDynamicHexHaloLinks,
  type HexHaloLink,
} from "./hex-halo.js";
import {
  HEX_GRID_DIRECTIONS,
  hexGridCenter,
  hexGridDistance,
  hexGridRadius,
  isHexGridCell,
  type HexGridDirection,
} from "./hex-grid.js";
import {
  agentPathogenLoad,
  applyPathogenSteps,
  PATHOGEN_HALO_INTERVAL,
  PATHOGEN_LOCAL_INTERVAL,
  pathogenEdgeSnapshot,
  pathogenHaloPressureMap,
  pathogenHaloReservoirMap,
  pathogenStepCount,
  type PathogenEdgeSnapshot,
  type PathogenEnvironmentFrame,
} from "./pathogen.js";
import { positionKey, type GridPosition, type WorldState } from "./protocol.js";
import { regionGlobalCellOrigin } from "./region-topology.js";
import { WorldRuntime } from "./runtime.js";

interface PathogenEnv {
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
  persist(): Promise<void>;
  broadcastSnapshot(): void;
}

export interface PathogenHaloEdgeRequest {
  regionId: string;
  direction: HexGridDirection;
  positions: GridPosition[];
}

interface MaterializedPathogenHalo {
  pressure: Map<string, number>;
  reservoir: Map<string, number>;
}

const INTERNAL_PATHOGEN_EDGE_PATH = "/api/internal/pathogen/edge";
const DEFAULT_WORLD_SEED = 424_242;

function runtimeAccess(instance: RegionDurableObject): RuntimeAccess {
  return instance as unknown as RuntimeAccess;
}

function configuredRegionIds(env: PathogenEnv): string[] {
  const configured = env.REGION_IDS ?? env.DEFAULT_REGION_ID ?? "garden-1";
  const regions = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(entry));
  return regions.length > 0 ? [...new Set(regions)] : ["garden-1"];
}

function worldSeedValue(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 0x7fff_ffff
    ? parsed
    : DEFAULT_WORLD_SEED;
}

function directionValue(value: string | null): HexGridDirection | undefined {
  return value !== null && HEX_GRID_DIRECTIONS.includes(value as HexGridDirection)
    ? value as HexGridDirection
    : undefined;
}

function requestedPathogenEdgeCells(values: readonly string[]): Set<string> | undefined | null {
  if (values.length === 0) return undefined;
  const result = new Set<string>();
  for (const value of values) {
    const match = /^(-?\d+),(-?\d+)$/.exec(value);
    if (match === null) return null;
    const xText = match[1];
    const yText = match[2];
    if (xText === undefined || yText === undefined) return null;
    const x = Number.parseInt(xText, 10);
    const y = Number.parseInt(yText, 10);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
    result.add(positionKey({ x, y }));
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathogenEdgeSnapshot(value: unknown): value is PathogenEdgeSnapshot {
  if (
    !isRecord(value) ||
    typeof value.regionId !== "string" ||
    !HEX_GRID_DIRECTIONS.includes(value.direction as HexGridDirection) ||
    !Number.isInteger(value.revision) ||
    !Number.isInteger(value.tick) ||
    !Array.isArray(value.agents)
  ) {
    return false;
  }
  const validAgents = value.agents.every((entry) =>
    isRecord(entry) &&
    isRecord(entry.position) &&
    Number.isInteger(entry.position.x) &&
    Number.isInteger(entry.position.y) &&
    typeof entry.pressure === "number" &&
    Number.isFinite(entry.pressure) &&
    entry.pressure >= 0 &&
    entry.pressure <= 1
  );
  if (!validAgents) return false;
  if (value.reservoirs === undefined) return true;
  return Array.isArray(value.reservoirs) && value.reservoirs.every((entry) =>
    isRecord(entry) &&
    isRecord(entry.position) &&
    Number.isInteger(entry.position.x) &&
    Number.isInteger(entry.position.y) &&
    typeof entry.burden === "number" &&
    Number.isFinite(entry.burden) &&
    entry.burden >= 0 &&
    entry.burden <= 1
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function shouldMaterializePathogenHalo(
  state: Pick<WorldState, "width" | "height" | "agents">,
  fromTick: number,
  toTick: number,
): boolean {
  if (pathogenStepCount(fromTick, toTick, PATHOGEN_HALO_INTERVAL) <= 0) return false;
  const center = hexGridCenter(state);
  const radius = hexGridRadius(state);
  return state.agents.some((agent) =>
    isHexGridCell(state, agent.position) &&
    hexGridDistance(agent.position, center) === radius
  );
}

/**
 * Keep pathogen edge reads proportional to actual cross-seam contact.
 *
 * A full dynamic depth-1 halo can reference all six neighboring Durable Objects,
 * but pathogen pressure is consumed only by BOTs standing on the paired local
 * boundary cell. Filtering links before any neighbor fetch preserves every
 * possible exposure (including corner cells that legitimately map to multiple
 * neighbors) while avoiding unrelated DO wakeups for empty seams.
 */
export function pathogenHaloLinksForAgents(
  state: Pick<WorldState, "agents">,
  links: readonly HexHaloLink[],
): HexHaloLink[] {
  if (state.agents.length === 0 || links.length === 0) return [];
  const occupied = new Set(state.agents.map((agent) => positionKey(agent.position)));
  return links.filter((link) => occupied.has(positionKey(link.sourcePosition)));
}

/**
 * Group occupied halo links by remote edge while retaining only the exact ghost
 * cells that can affect a local BOT. This keeps the existing DO fan-out contract
 * but avoids returning an entire edge snapshot when one or two paired cells are
 * sufficient for the current pathogen step.
 */
export function pathogenHaloEdgeRequests(
  links: readonly HexHaloLink[],
): PathogenHaloEdgeRequest[] {
  const grouped = new Map<string, {
    regionId: string;
    direction: HexGridDirection;
    positions: Map<string, GridPosition>;
  }>();
  for (const link of links) {
    const key = `${link.neighborRegionId}:${link.neighborDirection}`;
    let request = grouped.get(key);
    if (request === undefined) {
      request = {
        regionId: link.neighborRegionId,
        direction: link.neighborDirection,
        positions: new Map(),
      };
      grouped.set(key, request);
    }
    request.positions.set(positionKey(link.neighborPosition), { ...link.neighborPosition });
  }
  return [...grouped.values()]
    .map((request) => ({
      regionId: request.regionId,
      direction: request.direction,
      positions: [...request.positions.values()].sort((a, b) => a.y - b.y || a.x - b.x),
    }))
    .sort((a, b) =>
      a.regionId.localeCompare(b.regionId) || a.direction.localeCompare(b.direction)
    );
}

export class RegionDurableObject extends AutonomyRegionDurableObject {
  constructor(
    private readonly pathogenState: DurableObjectState,
    private readonly pathogenEnv: PathogenEnv,
  ) {
    super(pathogenState, pathogenEnv);
  }

  private pathogenStub(regionId: string): DurableObjectStub {
    return this.pathogenEnv.REGIONS.get(this.pathogenEnv.REGIONS.idFromName(regionId));
  }

  private async ensurePathogenAssigned(request: Request): Promise<Response | undefined> {
    try {
      await this.ensureRegion(request, { activate: false });
      return undefined;
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "region routing failed" }, 400);
    }
  }

  private pathogenEnvironmentFrame(state: WorldState): PathogenEnvironmentFrame | undefined {
    const origin = regionGlobalCellOrigin(state.regionId, state.width, state.height);
    if (origin === undefined) return undefined;
    return {
      worldSeed: worldSeedValue(this.pathogenEnv.WORLD_SEED),
      originX: origin.x,
      originY: origin.y,
    };
  }

  private pathogenHaloLinks(state: WorldState): HexHaloLink[] {
    // Regions that already participate in the shared global axial cell frame use
    // exact six-direction ownership at every activity tier. Historical IDs with
    // no global identity retain the configured compatibility halo.
    if (regionGlobalCellOrigin(state.regionId, state.width, state.height) !== undefined) {
      return buildDynamicHexHaloLinks(state, state.regionId);
    }
    return buildConfiguredHexHaloLinks(
      state,
      configuredRegionIds(this.pathogenEnv),
      state.regionId,
    );
  }

  private async fetchNeighborPathogenEdge(
    regionId: string,
    direction: HexGridDirection,
    positions: readonly GridPosition[],
  ): Promise<PathogenEdgeSnapshot | undefined> {
    const url = new URL(`https://moyo.internal${INTERNAL_PATHOGEN_EDGE_PATH}`);
    url.searchParams.set("direction", direction);
    for (const position of positions) {
      url.searchParams.append("cell", positionKey(position));
    }
    try {
      const response = await this.pathogenStub(regionId).fetch(new Request(url, {
        method: "GET",
        headers: { "x-moyo-region-internal": regionId },
      }));
      if (!response.ok) return undefined;
      const value = await response.json() as unknown;
      return isPathogenEdgeSnapshot(value) ? value : undefined;
    } catch (error) {
      console.debug("MoYoGarden pathogen edge unavailable", regionId, direction, error);
      return undefined;
    }
  }

  private async materializePathogenHalo(state: WorldState): Promise<MaterializedPathogenHalo> {
    const links = pathogenHaloLinksForAgents(state, this.pathogenHaloLinks(state));
    if (links.length === 0) {
      return { pressure: new Map(), reservoir: new Map() };
    }
    const requests = pathogenHaloEdgeRequests(links);
    const edges = (
      await Promise.all(
        requests.map(({ regionId, direction, positions }) =>
          this.fetchNeighborPathogenEdge(regionId, direction, positions)
        ),
      )
    ).filter((value): value is PathogenEdgeSnapshot => value !== undefined);
    return {
      pressure: pathogenHaloPressureMap(links, edges),
      reservoir: pathogenHaloReservoirMap(links, edges),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === INTERNAL_PATHOGEN_EDGE_PATH) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      const assignmentError = await this.ensurePathogenAssigned(request);
      if (assignmentError !== undefined) return assignmentError;
      const direction = directionValue(url.searchParams.get("direction"));
      if (direction === undefined) return json({ error: "valid hex direction is required" }, 400);
      const requestedCells = requestedPathogenEdgeCells(url.searchParams.getAll("cell"));
      if (requestedCells === null) return json({ error: "valid pathogen edge cells are required" }, 400);
      const state = runtimeAccess(this).runtime.snapshot();
      const snapshotState = requestedCells === undefined
        ? state
        : {
          ...state,
          agents: state.agents.filter((agent) => requestedCells.has(positionKey(agent.position))),
          tiles: state.tiles.filter((tile) => requestedCells.has(positionKey(tile))),
        };
      return json(pathogenEdgeSnapshot(snapshotState, direction));
    }
    return super.fetch(request);
  }

  override async alarm(): Promise<void> {
    const access = runtimeAccess(this);
    const beforeTick = access.runtime.snapshot().tick;
    await super.alarm();

    const state = access.runtime.snapshot();
    const localSteps = pathogenStepCount(beforeTick, state.tick, PATHOGEN_LOCAL_INTERVAL);
    if (localSteps <= 0) return;
    const haloSteps = pathogenStepCount(beforeTick, state.tick, PATHOGEN_HALO_INTERVAL);
    const halo = shouldMaterializePathogenHalo(state, beforeTick, state.tick)
      ? await this.materializePathogenHalo(state)
      : { pressure: new Map<string, number>(), reservoir: new Map<string, number>() };
    const changed = applyPathogenSteps(
      state,
      localSteps,
      this.pathogenEnvironmentFrame(state),
      halo.pressure,
      haloSteps,
      halo.reservoir,
    );
    if (changed <= 0) return;

    access.runtime = new WorldRuntime({
      state,
      pendingCommands: access.runtime.pendingCommands(),
    });
    await access.persist();
    access.broadcastSnapshot();
  }
}

// Keep this tiny export useful to health/diagnostic tests without exposing a new
// public endpoint. A value above zero means the additive pathogen state survived
// ordinary WorldState persistence or an ownership handoff.
export function worldPathogenLoad(state: Pick<WorldState, "agents">): number {
  return state.agents.reduce((sum, agent) => sum + agentPathogenLoad(agent), 0);
}
