import { BUILD_BRANCH, BUILD_COMMIT, BUILD_SOURCE } from "./build-meta.js";
import { RegionDurableObject } from "./storage-reservation-region.js";
import { isHexGridCell } from "./hex-grid.js";
import {
  parseAxialRegionId,
  regionGlobalCellOrigin,
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

type RegionConfigEnv = Pick<WorkerEnv, "DEFAULT_REGION_ID" | "REGION_IDS">;
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

const PERSISTED_LEGACY_REGION_IDS = ["garden-1", "garden-2", "garden-3"] as const;

function isPersistedLegacyRegionId(regionId: string | undefined): regionId is (typeof PERSISTED_LEGACY_REGION_IDS)[number] {
  return regionId !== undefined && PERSISTED_LEGACY_REGION_IDS.some((candidate) => candidate === regionId);
}

function isSupportedRegionId(regionId: string | undefined): regionId is string {
  if (regionId === undefined || regionId === "") return false;
  if (isPersistedLegacyRegionId(regionId)) return true;
  if (parseAxialRegionId(regionId) === undefined) return false;
  try {
    return regionGlobalCellOrigin(regionId) !== undefined;
  } catch {
    return false;
  }
}

export { RegionDurableObject };

export function enrichMetaPayload(
  payload: unknown,
  build: BuildMetadata = DEFAULT_BUILD_METADATA,
  defaultRegion?: string,
): unknown {
  if (!isRecord(payload)) return payload;
  return {
    ...payload,
    ...(defaultRegion === undefined ? {} : { defaultRegion }),
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
  options: { compactCenter?: boolean } = {},
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
    const shouldCompactState =
      centerRegion !== undefined &&
      (value.regionId !== centerRegion || options.compactCenter === true);
    const state = shouldCompactState ? compactPassiveRegionState(value.state) : value.state;
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

function configuredRegionIds(_env: RegionConfigEnv): string[] {
  // Historical allow-list behavior is removed; the fixed persisted legacy set is
  // the only configuration-independent compatibility group.
  return [...PERSISTED_LEGACY_REGION_IDS];
}

/**
 * DEFAULT_REGION_ID is the public routing authority for omitted regions. After
 * termination, only canonical axial IDs and the three persisted production
 * aliases are valid defaults; unresolved historical defaults are rejected.
 */
export function configuredDefaultRegionId(env: RegionConfigEnv): string | undefined {
  const requested = env.DEFAULT_REGION_ID?.trim();
  if (requested === undefined || requested === "") return "garden-1";
  return isSupportedRegionId(requested) ? requested : undefined;
}

export function routeConfiguredDefaultRegion(
  request: Request,
  env: RegionConfigEnv,
): Request | Response {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/") || url.pathname === "/api/meta") return request;
  const requested =
    url.searchParams.get("region")?.trim() || request.headers.get("x-moyo-region")?.trim();
  if (requested !== undefined && requested !== "") return request;
  const defaultRegion = configuredDefaultRegionId(env);
  if (defaultRegion === undefined) return unknownRegionResponse();
  const headers = new Headers(request.headers);
  headers.set("x-moyo-region", defaultRegion);
  return new Request(request, { headers });
}

export function routeMetaRegionHeader(request: Request): Request {
  if (request.method !== "GET") return request;
  const url = new URL(request.url);
  if (url.pathname !== "/api/meta") return request;
  const queryRegion = url.searchParams.get("region")?.trim();
  if (queryRegion !== undefined && queryRegion !== "") return request;
  const headerRegion = request.headers.get("x-moyo-region")?.trim();
  if (headerRegion === undefined || headerRegion === "") return request;
  url.searchParams.set("region", headerRegion);
  return new Request(url.toString(), {
    method: "GET",
    headers: request.headers,
  });
}

export function routeImplicitCanonicalMetaRegion(
  request: Request,
  env: RegionConfigEnv,
): Request | Response {
  if (request.method !== "GET") return request;
  const url = new URL(request.url);
  if (url.pathname !== "/api/meta") return request;
  const requested =
    url.searchParams.get("region")?.trim() || request.headers.get("x-moyo-region")?.trim();
  if (requested !== undefined && requested !== "") return request;
  const defaultRegion = env.DEFAULT_REGION_ID?.trim();
  if (defaultRegion === undefined || defaultRegion === "") return request;
  if (parseAxialRegionId(defaultRegion) !== undefined) {
    if (!isSupportedRegionId(defaultRegion)) return unknownRegionResponse();
    url.searchParams.set("region", defaultRegion);
    return new Request(url.toString(), {
      method: "GET",
      headers: request.headers,
    });
  }
  // Unresolved historical default must 404 (termination slice).
  if (!isPersistedLegacyRegionId(defaultRegion)) return unknownRegionResponse();
  return request;
}

function routedRegionId(request: Request): string | undefined {
  const url = new URL(request.url);
  return url.searchParams.get("region")?.trim() || request.headers.get("x-moyo-region")?.trim() || undefined;
}

function implicitPersistedLegacyMetaRegion(request: Request, env: RegionConfigEnv): string | undefined {
  if (request.method !== "GET") return undefined;
  const url = new URL(request.url);
  if (url.pathname !== "/api/meta") return undefined;
  const requested =
    url.searchParams.get("region")?.trim() || request.headers.get("x-moyo-region")?.trim();
  if (requested !== undefined && requested !== "") return undefined;
  const defaultRegion = env.DEFAULT_REGION_ID?.trim();
  return isPersistedLegacyRegionId(defaultRegion) ? defaultRegion : undefined;
}

function listIndependentLegacyRoutingEnv(request: Request, env: WorkerEnv): WorkerEnv {
  const regionId = routedRegionId(request) ?? implicitPersistedLegacyMetaRegion(request, env);
  if (!isPersistedLegacyRegionId(regionId)) return env;
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "REGION_IDS") return PERSISTED_LEGACY_REGION_IDS.join(",");
      return Reflect.get(target, property, receiver);
    },
  });
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

function unknownRegionResponse(): Response {
  return new Response(JSON.stringify({ error: "unknown or disabled region" }), {
    status: 404,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
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

function unavailableCenterRegionWindow(): Response {
  return new Response(JSON.stringify({ error: "center region snapshot unavailable" }), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

class CenterRegionSnapshotUnavailable extends Error {}

export const REGION_WINDOW_SNAPSHOT_TIMEOUT_MS = 8_000;

export async function withRegionWindowSnapshotDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = REGION_WINDOW_SNAPSHOT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      const error = new Error("region window snapshot timed out");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function readRegionWindowSnapshotResponseWithDeadline(
  operation: (signal: AbortSignal) => Promise<Response>,
  timeoutMs = REGION_WINDOW_SNAPSHOT_TIMEOUT_MS,
): Promise<Response> {
  return withRegionWindowSnapshotDeadline(async (signal) => {
    const response = await operation(signal);
    const body = await response.arrayBuffer();
    const nullBodyStatus = response.status === 204 || response.status === 205 || response.status === 304;
    return new Response(nullBodyStatus ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }, timeoutMs);
}

function regionWindowCenter(request: Request, env: WorkerEnv): string | undefined {
  const url = new URL(request.url);
  const requested =
    url.searchParams.get("region")?.trim() || request.headers.get("x-moyo-region")?.trim();
  if (requested === undefined || requested === "") return configuredDefaultRegionId(env);
  return isSupportedRegionId(requested) ? requested : undefined;
}

function failSoftRegionWindowEnv(env: WorkerEnv, centerRegionId: string): WorkerEnv {
  const regions = {
    idFromName: (...args: Parameters<WorkerEnv["REGIONS"]["idFromName"]>) =>
      env.REGIONS.idFromName(...args),
    get: (...args: Parameters<WorkerEnv["REGIONS"]["get"]>) => {
      const stub = env.REGIONS.get(...args);
      return {
        fetch: async (...fetchArgs: Parameters<typeof stub.fetch>) => {
          const snapshotRequest = fetchArgs[0];
          try {
            return await readRegionWindowSnapshotResponseWithDeadline((signal) => {
              if (snapshotRequest instanceof Request) {
                return stub.fetch(new Request(snapshotRequest, { signal }));
              }
              return stub.fetch(...fetchArgs);
            });
          } catch {
            const routedRegionId = snapshotRequest instanceof Request
              ? snapshotRequest.headers.get("x-moyo-region-internal")?.trim()
              : undefined;
            if (routedRegionId === centerRegionId) {
              throw new CenterRegionSnapshotUnavailable();
            }
            return unavailableRegionSnapshot();
          }
        },
      } as typeof stub;
    },
  } as unknown as WorkerEnv["REGIONS"];
  const failSoftEnv = { ...env, REGIONS: regions };
  return isPersistedLegacyRegionId(centerRegionId)
    ? { ...failSoftEnv, REGION_IDS: PERSISTED_LEGACY_REGION_IDS.join(",") }
    : failSoftEnv;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const requestedRegion =
      url.searchParams.get("region")?.trim() || request.headers.get("x-moyo-region")?.trim();
    // Internal cross-region endpoints are reachable only through direct Durable
    // Object stub calls. Never proxy them from the public Worker surface.
    if (
      url.pathname.startsWith("/api/internal/handoff/") ||
      url.pathname.startsWith("/api/internal/halo/") ||
      url.pathname.startsWith("/api/internal/autonomy/") ||
      url.pathname.startsWith("/api/internal/pathogen/")
    ) {
      return hiddenInternalEndpoint();
    }

    const implicitMeta = routeImplicitCanonicalMetaRegion(routeMetaRegionHeader(request), env);
    if (implicitMeta instanceof Response) return implicitMeta;
    const defaultRouted = routeConfiguredDefaultRegion(implicitMeta, env);
    if (defaultRouted instanceof Response) return defaultRouted;
    const routedRequest = defaultRouted;
    const routedEnv = listIndependentLegacyRoutingEnv(routedRequest, env);
    const isRegionWindow = request.method === "GET" && url.pathname === "/api/world/window";
    let baseEnv = routedEnv;
    if (isRegionWindow) {
      const center = regionWindowCenter(routedRequest, routedEnv);
      if (center === undefined) return unknownRegionResponse();
      baseEnv = failSoftRegionWindowEnv(routedEnv, center);
    }
    let response: Response;
    try {
      response = await baseWorker.fetch(routedRequest, baseEnv);
    } catch (error) {
      if (isRegionWindow && error instanceof CenterRegionSnapshotUnavailable) {
        return unavailableCenterRegionWindow();
      }
      throw error;
    }

    if (request.method !== "GET" || !response.ok) return response;

    if (url.pathname === "/api/meta") {
      return jsonResponse(
        response,
        enrichMetaPayload(
          await response.json() as unknown,
          DEFAULT_BUILD_METADATA,
          requestedRegion ? undefined : configuredDefaultRegionId(env) ?? undefined,
        ),
      );
    }

    if (url.pathname === "/api/world/window") {
      const payload = await response.json() as unknown;
      const centerRegion = isRecord(payload) && typeof payload.centerRegion === "string"
        ? payload.centerRegion
        : undefined;
      const regionIds: readonly string[] = centerRegion !== undefined && parseAxialRegionId(centerRegion) !== undefined
        ? []
        : isPersistedLegacyRegionId(centerRegion)
          ? PERSISTED_LEGACY_REGION_IDS
          : PERSISTED_LEGACY_REGION_IDS;
      return jsonResponse(
        response,
        enrichRegionWindowPayload(payload, regionIds, {
          compactCenter: url.searchParams.get("terrain") === "1",
        }),
      );
    }

    return response;
  },
};
