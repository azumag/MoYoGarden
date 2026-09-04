import { applyHaloRegrowthCompensation } from "./halo-environment.js";
import {
  buildHexHaloLinks,
  materializeHexHalo,
  type HexHaloEdgeSnapshot,
  type HexHaloTile,
} from "./hex-halo.js";
import {
  HEX_GRID_DIRECTIONS,
  hexGridBoundaryCells,
  oppositeHexGridDirection,
  type HexGridDirection,
} from "./hex-grid.js";
import { RegionDurableObject as MoveRegionDurableObject } from "./move-handoff-region.js";
import type { WorldState } from "./protocol.js";
import { WorldRuntime } from "./runtime.js";
import { getTile } from "./world.js";

interface HaloEnv {
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

interface HaloMaterialization {
  links: ReturnType<typeof buildHexHaloLinks>;
  edges: HexHaloEdgeSnapshot[];
  halo: HexHaloTile[];
}

const INTERNAL_EDGE_PATH = "/api/internal/halo/edge";
const PUBLIC_HALO_PATH = "/api/world/halo";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function configuredRegionIds(env: HaloEnv): string[] {
  const configured = env.REGION_IDS ?? env.DEFAULT_REGION_ID ?? "garden-1";
  const regions = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(entry));
  return regions.length > 0 ? [...new Set(regions)] : ["garden-1"];
}

function directionValue(value: string | null): HexGridDirection | undefined {
  return value !== null && HEX_GRID_DIRECTIONS.includes(value as HexGridDirection)
    ? value as HexGridDirection
    : undefined;
}

function runtimeAccess(instance: RegionDurableObject): RuntimeAccess {
  return instance as unknown as RuntimeAccess;
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

export class RegionDurableObject extends MoveRegionDurableObject {
  constructor(
    state: DurableObjectState,
    private readonly haloEnv: HaloEnv,
  ) {
    super(state, haloEnv);
  }

  private async ensureHaloAssigned(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    url.pathname = "/api/health";
    url.search = "";
    const response = await super.fetch(new Request(url, {
      method: "GET",
      headers: request.headers,
    }));
    return response.ok ? undefined : response;
  }

  private edgeSnapshot(direction: HexGridDirection): HexHaloEdgeSnapshot {
    const state = runtimeAccess(this).runtime.snapshot();
    const tiles = hexGridBoundaryCells(state, direction).flatMap((position) => {
      const tile = getTile(state, position);
      return tile === undefined ? [] : [{ position: { ...position }, tile: structuredClone(tile) }];
    });
    return {
      regionId: state.regionId,
      direction,
      revision: state.revision,
      tick: state.tick,
      tiles,
    };
  }

  private haloStub(regionId: string): DurableObjectStub {
    return this.haloEnv.REGIONS.get(this.haloEnv.REGIONS.idFromName(regionId));
  }

  private async fetchNeighborEdge(
    neighborRegionId: string,
    direction: HexGridDirection,
  ): Promise<HexHaloEdgeSnapshot | undefined> {
    const url = new URL("https://moyo.internal/api/internal/halo/edge");
    url.searchParams.set("direction", direction);
    const response = await this.haloStub(neighborRegionId).fetch(new Request(url, {
      method: "GET",
      headers: { "x-moyo-region-internal": neighborRegionId },
    }));
    if (!response.ok) return undefined;
    const value = await response.json() as unknown;
    return isEdgeSnapshot(value) ? value : undefined;
  }

  private async materializeHaloForState(state: WorldState): Promise<HaloMaterialization> {
    const regionIds = configuredRegionIds(this.haloEnv);
    const links = buildHexHaloLinks(state, regionIds, state.regionId);
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
          this.fetchNeighborEdge(regionId, direction)
        ),
      )
    ).filter((value): value is HexHaloEdgeSnapshot => value !== undefined);
    return { links, edges, halo: materializeHexHalo(links, edges) };
  }

  private async haloSnapshot(): Promise<Response> {
    const state = runtimeAccess(this).runtime.snapshot();
    const { links, edges, halo } = await this.materializeHaloForState(state);

    return json({
      centerRegion: state.regionId,
      depth: 1,
      tick: state.tick,
      revision: state.revision,
      expectedLinks: links.length,
      materializedLinks: halo.length,
      neighborEdges: edges.map((edge) => ({
        regionId: edge.regionId,
        direction: edge.direction,
        tick: edge.tick,
        revision: edge.revision,
        tiles: edge.tiles.length,
      })),
      halo,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === INTERNAL_EDGE_PATH || url.pathname === PUBLIC_HALO_PATH) {
      const assignmentError = await this.ensureHaloAssigned(request);
      if (assignmentError !== undefined) return assignmentError;
    }

    if (request.method === "GET" && url.pathname === INTERNAL_EDGE_PATH) {
      const direction = directionValue(url.searchParams.get("direction"));
      if (direction === undefined) return json({ error: "valid hex direction is required" }, 400);
      return json(this.edgeSnapshot(direction));
    }
    if (request.method === "GET" && url.pathname === PUBLIC_HALO_PATH) {
      return this.haloSnapshot();
    }
    return super.fetch(request);
  }

  override async alarm(): Promise<void> {
    const access = runtimeAccess(this);
    const before = access.runtime.snapshot();
    const { halo } = await this.materializeHaloForState(before);
    await super.alarm();

    const after = access.runtime.snapshot();
    const grown = applyHaloRegrowthCompensation(before, after, halo);
    if (grown <= 0) return;

    access.runtime = new WorldRuntime({
      state: after,
      pendingCommands: access.runtime.pendingCommands(),
    });
    await access.persist();
    access.broadcastSnapshot();
  }
}
