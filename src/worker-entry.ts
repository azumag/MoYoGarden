import { BUILD_BRANCH, BUILD_COMMIT, BUILD_SOURCE } from "./build-meta.js";
import { RegionDurableObject } from "./autonomy-region.js";
import { isHexGridCell } from "./hex-grid.js";
import {
  parseAxialRegionId,
  regionHexTopology,
  sparseCanonicalRegionHexWindow,
  sparseRegionHexWindow,
} from "./region-topology.js";
import baseWorker from "./worker.js";

interface WorkerEnv {
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

type JsonRecord = Record<string, unknown>;

export interface BuildMetadata {
  commit: string;
  branch: string;
  source: string;
}

const DEFAULT_BUILD_METADATA: BuildMetadata = {
  commit: BUILD_COMMIT,
  branch: BUILD_BRANCH,
  source: BUILD_SOURCE,
};

export { RegionDurableObject };

export function enrichMetaPayload(
  payload: unknown,
  build: BuildMetadata = DEFAULT_BUILD_METADATA,
): unknown {
  if (!isRecord(payload)) return payload;
  return {
    ...payload,
    build,
  };
}

function compactPassiveRegionState(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.tiles)) return value;
  const width = typeof value.width === "number" && Number.isInteger(value.width)
    ? value.width
    : undefined;
  const height = typeof value.height === "number" && Number.isInteger(value.height)
    ? value.height
    : undefined;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return value;

  const extent = { width, height };
  const tiles = value.tiles.filter((tile) => {
    if (!isRecord(tile)) return false;
    const x = typeof tile.x === "number" ? tile.x : Number.NaN;
    const y = typeof tile.y === "number" ? tile.y : Number.NaN;
    return isHexGridCell(extent, { x, y });
  });
  if (tiles.length === value.tiles.length) return value;
  return { ...value, tiles };
}

export function enrichRegionWindowPayload(
  payload: unknown,
  regionIds: readonly string[],
): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.chunks)) return payload;

  const centerRegion = typeof payload.centerRegion === "string" ? payload.centerRegion : undefined;
  const radius = typeof payload.radius === "number" && Number.isFinite(payload.radius)
    ? Math.max(0, Math.min(4, Math.floor(payload.radius)))
    : 1;
  const topology = new Map(
    (centerRegion === undefined
      ? regionHexTopology(regionIds)
      : parseAxialRegionId(centerRegion) !== undefined
        ? sparseCanonicalRegionHexWindow(centerRegion, radius)
        : sparseRegionHexWindow(regionIds, centerRegion, radius))
      .map((entry) => [entry.id, entry] as const),
  );
  const chunks = payload.chunks.map((value) => {
    if (!isRecord(value) || typeof value.regionId !== "string") return value;
    const placement = topology.get(value.regionId);
    if (placement === undefined) return value;
    const state = centerRegion !== undefined && value.regionId !== centerRegion
      ? compactPassiveRegionState(value.state)
      : value.state;
    return {
      ...value,
      ...(state === value.state ? {} : { state }),
      axial: placement.axial,
      physicalOrigin: placement.physicalOrigin,
      hexOrigin: placement.hexOrigin,
      globalCellOrigin: placement.globalCellOrigin,
      ring: placement.ring,
    };
  });

  return {
    ...payload,
    layoutMode: "hex-migration",
    originSemantics: {
      origin: "physical",
      physicalOrigin: "persisted-rectangular-ownership",
      hexOrigin: "logical-hex-placement",
      globalCellOrigin: "shared-axial-cell-frame",
    },
    chunks,
  };
}

function configuredRegionIds(env: WorkerEnv): string[] {
  const configured = env.REGION_IDS ?? env.DEFAULT_REGION_ID ?? "garden-1";
  const regions = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(entry));
  return regions.length > 0 ? [...new Set(regions)] : ["garden-1"];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function jsonResponse(response: Response, payload: unknown): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function hiddenInternalEndpoint(): Response {
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function unavailableRegionSnapshot(): Response {
  return new Response(JSON.stringify({ error: "snapshot unavailable" }), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function failSoftRegionWindowEnv(env: WorkerEnv): WorkerEnv {
  const regions = {
    idFromName: (...args: Parameters<WorkerEnv["REGIONS"]["idFromName"]>) =>
      env.REGIONS.idFromName(...args),
    get: (...args: Parameters<WorkerEnv["REGIONS"]["get"]>) => {
      const stub = env.REGIONS.get(...args);
      return {
        fetch: async (...fetchArgs: Parameters<typeof stub.fetch>) => {
          try {
            return await stub.fetch(...fetchArgs);
          } catch {
            return unavailableRegionSnapshot();
          }
        },
      } as typeof stub;
    },
  } as unknown as WorkerEnv["REGIONS"];
  return { ...env, REGIONS: regions };
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    // Internal cross-region endpoints are reachable only through direct Durable
    // Object stub calls. Never proxy them from the public Worker surface.
    if (
      url.pathname.startsWith("/api/internal/handoff/") ||
      url.pathname.startsWith("/api/internal/halo/") ||
      url.pathname.startsWith("/api/internal/autonomy/")
    ) {
      return hiddenInternalEndpoint();
    }

    // A radius window is a best-effort aggregation of independent region DOs.
    // Isolate a transient stub transport failure to that one chunk so the base
    // worker can return its existing non-OK chunk shape instead of rejecting the
    // entire six-neighbor window. Other API routes keep their original failure
    // semantics; only the read-only window fan-out gets this fail-soft wrapper.
    const baseEnv = request.method === "GET" && url.pathname === "/api/world/window"
      ? failSoftRegionWindowEnv(env)
      : env;
    const response = await baseWorker.fetch(request, baseEnv);

    if (request.method !== "GET" || !response.ok) return response;

    if (url.pathname === "/api/meta") {
      return jsonResponse(response, enrichMetaPayload(await response.json() as unknown));
    }

    if (url.pathname === "/api/world/window") {
      const payload = await response.json() as unknown;
      const centerRegion = isRecord(payload) && typeof payload.centerRegion === "string"
        ? payload.centerRegion
        : undefined;
      const regionIds = centerRegion !== undefined && parseAxialRegionId(centerRegion) !== undefined
        ? []
        : configuredRegionIds(env);
      return jsonResponse(response, enrichRegionWindowPayload(payload, regionIds));
    }

    return response;
  },
};