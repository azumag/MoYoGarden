import baseWorker, { RegionDurableObject } from "./worker.js";
import { regionHexTopology } from "./region-topology.js";

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

export { RegionDurableObject };

export function enrichRegionWindowPayload(
  payload: unknown,
  regionIds: readonly string[],
): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.chunks)) return payload;

  const topology = new Map(
    regionHexTopology(regionIds).map((entry) => [entry.id, entry] as const),
  );
  const chunks = payload.chunks.map((value) => {
    if (!isRecord(value) || typeof value.regionId !== "string") return value;
    const placement = topology.get(value.regionId);
    if (placement === undefined) return value;
    return {
      ...value,
      axial: placement.axial,
      physicalOrigin: placement.physicalOrigin,
      hexOrigin: placement.hexOrigin,
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

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const response = await baseWorker.fetch(request, env);
    const url = new URL(request.url);
    if (
      request.method !== "GET"
      || url.pathname !== "/api/world/window"
      || !response.ok
    ) {
      return response;
    }

    const payload = await response.json() as unknown;
    const enriched = enrichRegionWindowPayload(payload, configuredRegionIds(env));
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(enriched), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
