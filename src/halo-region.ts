import {
  applyHaloRegrowthCompensation,
  type HaloEnvironmentFrame,
} from "./halo-environment.js";
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
import { regionHexTopology } from "./region-topology.js";
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

type RegionActivityTier = "active" | "warm" | "cold";

const INTERNAL_EDGE_PATH = "/api/internal/halo/edge";
const PUBLIC_HALO_PATH = "/api/world/halo";
const ACTIVE_GRACE_MULTIPLIER = 6;
const WARM_GRACE_MULTIPLIER = 12;
const WARM_TICK_MULTIPLIER = 6;
const COLD_TICK_MULTIPLIER = 60;
const MAX_ACTIVITY_TICK_MS = 3_600_000;
const HALO_REGROWTH_INTERVAL = 30;
const DEFAULT_WORLD_SEED = 424_242;

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

function tickMsValue(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 3_600_000 ? parsed : 10_000;
}

function activityDelayMs(tickMs: number, tier: RegionActivityTier): number {
  if (tier === "active") return tickMs;
  const multiplier = tier === "warm" ? WARM_TICK_MULTIPLIER : COLD_TICK_MULTIPLIER;
  return Math.min(MAX_ACTIVITY_TICK_MS, tickMs * multiplier);
}

export function shouldMaterializeHaloForTick(currentTick: number): boolean {
  const nextTick = currentTick + 1;
  return nextTick > 0 && nextTick % HALO_REGROWTH_INTERVAL === 0;
}

export class RegionDurableObject extends MoveRegionDurableObject {
  private readonly activityTickMs: number;
  private lastDirectActivityAt = 0;
  private lastWarmActivityAt = 0;

  constructor(
    private readonly activityState: DurableObjectState,
    private readonly haloEnv: HaloEnv,
  ) {
    super(activityState, haloEnv);
    this.activityTickMs = tickMsValue(haloEnv.TICK_MS);
  }

  private activityTier(now = Date.now()): RegionActivityTier {
    if (this.activityState.getWebSockets().length > 0) return "active";
    const activeGraceMs = Math.min(
      MAX_ACTIVITY_TICK_MS,
      this.activityTickMs * ACTIVE_GRACE_MULTIPLIER,
    );
    if (
      this.lastDirectActivityAt > 0 &&
      now - this.lastDirectActivityAt <= activeGraceMs
    ) {
      return "active";
    }
    const warmGraceMs = Math.min(
      MAX_ACTIVITY_TICK_MS,
      this.activityTickMs * WARM_GRACE_MULTIPLIER,
    );
    if (
      this.lastWarmActivityAt > 0 &&
      now - this.lastWarmActivityAt <= warmGraceMs
    ) {
      return "warm";
    }
    return "cold";
  }

  private noteRequestActivity(request: Request): boolean {
    const url = new URL(request.url);
    const passivePrefetch =
      request.method === "GET" &&
      url.pathname === "/api/world/snapshot" &&
      request.headers.get("x-moyo-prefetch") === "1";
    const now = Date.now();
    if (passivePrefetch) {
      this.lastWarmActivityAt = now;
      return true;
    }
    if (
      url.pathname === "/api/health" ||
      url.pathname === "/api/rules" ||
      url.pathname === INTERNAL_EDGE_PATH
    ) {
      return false;
    }
    this.lastDirectActivityAt = now;
    this.lastWarmActivityAt = now;
    return true;
  }

  private async shortenAlarmForActivity(): Promise<void> {
    const scheduled = await this.activityState.storage.getAlarm();
    if (scheduled === null) return;
    const desired = Date.now() + activityDelayMs(this.activityTickMs, this.activityTier());
    if (scheduled > desired) await this.activityState.storage.setAlarm(desired);
  }

  private async applyAlarmTierAfterTick(): Promise<void> {
    if ((await this.activityState.storage.getAlarm()) === null) return;
    await this.activityState.storage.setAlarm(
      Date.now() + activityDelayMs(this.activityTickMs, this.activityTier()),
    );
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

  private haloEnvironmentFrame(state: WorldState): HaloEnvironmentFrame {
    const entry = regionHexTopology(
      configuredRegionIds(this.haloEnv),
      state.width,
      state.height,
    ).find((candidate) => candidate.id === state.regionId);
    const origin = entry?.physicalOrigin ?? { x: 0, y: 0 };
    return {
      worldSeed: worldSeedValue(this.haloEnv.WORLD_SEED),
      originX: origin.x,
      originY: origin.y,
    };
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
    const touchedActivity = this.noteRequestActivity(request);
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === INTERNAL_EDGE_PATH || url.pathname === PUBLIC_HALO_PATH) {
      const assignmentError = await this.ensureHaloAssigned(request);
      if (assignmentError !== undefined) return assignmentError;
    }

    if (request.method === "GET" && url.pathname === INTERNAL_EDGE_PATH) {
      const direction = directionValue(url.searchParams.get("direction"));
      response = direction === undefined
        ? json({ error: "valid hex direction is required" }, 400)
        : json(this.edgeSnapshot(direction));
    } else if (request.method === "GET" && url.pathname === PUBLIC_HALO_PATH) {
      response = await this.haloSnapshot();
    } else {
      response = await super.fetch(request);
    }

    if (touchedActivity && response.ok) await this.shortenAlarmForActivity();

    if (request.method === "GET" && url.pathname === "/api/health" && response.ok) {
      const payload = await response.json() as unknown;
      if (!isRecord(payload)) return response;
      const tier = this.activityTier();
      return json({
        ...payload,
        effectiveTickMs: activityDelayMs(this.activityTickMs, tier),
        tickMode: tier,
      });
    }
    return response;
  }

  override async alarm(): Promise<void> {
    const access = runtimeAccess(this);
    const before = access.runtime.snapshot();
    const halo = shouldMaterializeHaloForTick(before.tick)
      ? (await this.materializeHaloForState(before)).halo
      : [];
    await super.alarm();

    const after = access.runtime.snapshot();
    const grown = applyHaloRegrowthCompensation(
      before,
      after,
      halo,
      HALO_REGROWTH_INTERVAL,
      this.haloEnvironmentFrame(after),
    );
    if (grown > 0) {
      access.runtime = new WorldRuntime({
        state: after,
        pendingCommands: access.runtime.pendingCommands(),
      });
      await access.persist();
      access.broadcastSnapshot();
    }
    await this.applyAlarmTierAfterTick();
  }
}