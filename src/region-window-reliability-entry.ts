import baseWorker, {
  RegionDurableObject,
} from "./destination-storage-terminal-region.js";
import { configuredDefaultRegionId } from "./worker-entry.js";

interface RegionWindowReliabilityEnv {
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

function unavailableRegionSnapshot(): Response {
  return new Response(JSON.stringify({ error: "snapshot unavailable" }), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function regionWindowCenter(request: Request, env: RegionWindowReliabilityEnv): string {
  const url = new URL(request.url);
  const requested =
    url.searchParams.get("region")?.trim() || request.headers.get("x-moyo-region")?.trim();
  return requested === undefined || requested === ""
    ? configuredDefaultRegionId(env)
    : requested;
}

function routedSnapshotRegionId(input: RequestInfo | URL): string | undefined {
  if (!(input instanceof Request)) return undefined;
  return input.headers.get("x-moyo-region-internal")?.trim() || undefined;
}

async function validatedSnapshotResponse(
  response: Response,
  routedRegionId: string | undefined,
  centerRegionId: string,
): Promise<Response> {
  if (!response.ok) {
    if (routedRegionId === centerRegionId) {
      throw new Error(`center snapshot HTTP ${response.status}`);
    }
    return response;
  }

  const body = await response.arrayBuffer();
  try {
    JSON.parse(new TextDecoder().decode(body));
  } catch {
    if (routedRegionId === centerRegionId) {
      throw new Error("center snapshot returned malformed JSON");
    }
    return unavailableRegionSnapshot();
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function reliableRegionWindowEnv(
  request: Request,
  env: RegionWindowReliabilityEnv,
): RegionWindowReliabilityEnv {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/api/world/window") return env;
  const centerRegionId = regionWindowCenter(request, env);
  const regions = {
    idFromName: (...args: Parameters<RegionWindowReliabilityEnv["REGIONS"]["idFromName"]>) =>
      env.REGIONS.idFromName(...args),
    get: (...args: Parameters<RegionWindowReliabilityEnv["REGIONS"]["get"]>) => {
      const stub = env.REGIONS.get(...args);
      return {
        fetch: async (...fetchArgs: Parameters<typeof stub.fetch>) => {
          const routedRegionId = routedSnapshotRegionId(fetchArgs[0]);
          const response = await stub.fetch(...fetchArgs);
          return validatedSnapshotResponse(response, routedRegionId, centerRegionId);
        },
      } as typeof stub;
    },
  } as unknown as RegionWindowReliabilityEnv["REGIONS"];
  return { ...env, REGIONS: regions };
}

export { RegionDurableObject };

export default {
  async fetch(request: Request, env: RegionWindowReliabilityEnv): Promise<Response> {
    return baseWorker.fetch(request, reliableRegionWindowEnv(request, env));
  },
};
