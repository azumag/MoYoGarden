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

export const REGION_WINDOW_SNAPSHOT_BODY_TIMEOUT_MS = 5_000;

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

function readChunkWithinTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error("snapshot body read timed out"));
    }, timeoutMs);
    reader.read().then(
      (result) => {
        globalThis.clearTimeout(timeoutId);
        resolve(result);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

export async function readSnapshotBodyWithinDeadline(
  response: Response,
  timeoutMs = REGION_WINDOW_SNAPSHOT_BODY_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("snapshot body timeout must be positive");
  }
  if (response.body === null) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const deadlineAtMs = Date.now() + timeoutMs;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) throw new Error("snapshot body read timed out");
      const result = await readChunkWithinTimeout(reader, remainingMs);
      if (result.done) break;
      if (result.value === undefined || result.value.byteLength === 0) continue;
      chunks.push(result.value);
      totalBytes += result.value.byteLength;
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling cancellation. The response is no
      // longer used, so retaining the lock briefly is preferable to blocking the
      // window request on a broken neighbor body.
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
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

  let body: ArrayBuffer;
  try {
    body = await readSnapshotBodyWithinDeadline(response);
  } catch {
    if (routedRegionId === centerRegionId) {
      throw new Error("center snapshot body unavailable");
    }
    return unavailableRegionSnapshot();
  }

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
