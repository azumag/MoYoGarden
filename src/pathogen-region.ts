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
  pathogenStepCount,
  type PathogenEdgeSnapshot,
  type PathogenEnvironmentFrame,
} from "./pathogen.js";
import { positionKey, type WorldState } from "./protocol.js";
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
  return value.agents.every((entry) =>
    isRecord(entry) &&
    isRecord(entry.position) &&
    Number.isInteger(entry.position.x) &&
    Number.isInteger(entry.position.y) &&
    typeof entry.pressure === "number" &&
    Number.isFinite(entry.pressure) &&
    entry.pressure >= 0 &&
    entry.pressure <= 1
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
    const url = new URL(request.url);
    url.pathname = "/api/health";
    url.search = "";
    const response = await super.fetch(new Request(url, {
      method: "GET",
      headers: request.headers,
    }));
    return response.ok ? undefined : response;
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
  ): Promise<PathogenEdgeSnapshot | undefined> {
    const url = new URL(`https://moyo.internal${INTERNAL_PATHOGEN_EDGE_PATH}`);
    url.searchParams.set("direction", direction);
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

  private async materializePathogenPressure(state: WorldState): Promise<Map<string, number>> {
    const links = pathogenHaloLinksForAgents(state, this.pathogenHaloLinks(state));
    if (links.length === 0) return new Map();
    const requested = new Map<string, { regionId: string; direction: HexGridDirection }>();
    for (const link of links) {
      requested.set(`${link.neighborRegionId}:${link.neighborDirection}`, {
        regionId: link.neighborRegionId,
        direction: link.neighborDirection,
      });
    }
    const edges = (
      await Promise.all(
        [...requested.values()].map(({ regionId, direction }) =>
          this.fetchNeighborPathogenEdge(regionId, direction)
        ),
      )
    ).filter((value): value is PathogenEdgeSnapshot => value !== undefined);
    return pathogenHaloPressureMap(links, edges);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === INTERNAL_PATHOGEN_EDGE_PATH) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      const assignmentError = await this.ensurePathogenAssigned(request);
      if (assignmentError !== undefined) return assignmentError;
      const direction = directionValue(url.searchParams.get("direction"));
      if (direction === undefined) return json({ error: "valid hex direction is required" }, 400);
      return json(pathogenEdgeSnapshot(runtimeAccess(this).runtime.snapshot(), direction));
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
    const haloPressure = shouldMaterializePathogenHalo(state, beforeTick, state.tick)
      ? await this.materializePathogenPressure(state)
      : new Map<string, number>();
    const changed = applyPathogenSteps(
      state,
      localSteps,
      this.pathogenEnvironmentFrame(state),
      haloPressure,
      haloSteps,
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
