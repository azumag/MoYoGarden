import baseWorker, {
  RegionDurableObject as RegionWindowReliabilityRegionDurableObject,
} from "./region-window-reliability-entry.js";

interface ArrivalRegistrationReliabilityEnv {
  REGIONS: DurableObjectNamespace;
  ASSETS: Fetcher;
  DEFAULT_REGION_ID?: string;
  REGION_IDS?: string;
  WORLD_SEED?: string;
  TICK_MS?: string;
  OPEN_COMMANDS?: string;
  COMMAND_TOKEN?: string;
  ADMIN_TOKEN?: string;
}

const INTERNAL_CLAIM_REGISTER_PATH = "/api/internal/autonomy/claim/register";
export const ARRIVAL_REGISTRATION_RETRY_ALARM_INTERVAL_MS = 60 * 1_000;
export const ARRIVAL_REGISTRATION_RETRY_TIMEOUT_MS = 5_000;

export function arrivalRegistrationRetryAlarmTarget(
  currentAlarmAtMs: number | null,
  now = Date.now(),
): number | undefined {
  const retryAtMs = now + ARRIVAL_REGISTRATION_RETRY_ALARM_INTERVAL_MS;
  return currentAlarmAtMs === null || currentAlarmAtMs > retryAtMs
    ? retryAtMs
    : undefined;
}

export async function withArrivalRegistrationDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = ARRIVAL_REGISTRATION_RETRY_TIMEOUT_MS,
): Promise<T> {
  const boundedTimeout = Math.max(1, Math.min(60_000, Math.floor(timeoutMs)));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`arrival claim registration exceeded ${boundedTimeout}ms`);
      error.name = "TimeoutError";
      controller.abort(error);
      reject(error);
    }, boundedTimeout);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function ensureArrivalRegistrationRetryAlarm(
  state: DurableObjectState,
  now = Date.now(),
): Promise<void> {
  const currentAlarmAtMs = await state.storage.getAlarm();
  const target = arrivalRegistrationRetryAlarmTarget(currentAlarmAtMs, now);
  if (target !== undefined) await state.storage.setAlarm(target);
}

function reliableArrivalRegistrationEnv(
  env: ArrivalRegistrationReliabilityEnv,
  state: DurableObjectState,
): ArrivalRegistrationReliabilityEnv {
  const regions = new Proxy(env.REGIONS, {
    get(target, property, receiver) {
      if (property !== "get") return Reflect.get(target, property, receiver);
      return (...getArgs: Parameters<ArrivalRegistrationReliabilityEnv["REGIONS"]["get"]>) => {
        const stub = target.get(...getArgs);
        return new Proxy(stub, {
          get(stubTarget, stubProperty, stubReceiver) {
            if (stubProperty !== "fetch") {
              return Reflect.get(stubTarget, stubProperty, stubReceiver);
            }
            return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
              const request = new Request(input, init);
              const url = new URL(request.url);
              if (request.method !== "POST" || url.pathname !== INTERNAL_CLAIM_REGISTER_PATH) {
                return stub.fetch(request);
              }

              try {
                const response = await withArrivalRegistrationDeadline((signal) =>
                  stub.fetch(new Request(request, { signal }))
                );
                if (!response.ok) await ensureArrivalRegistrationRetryAlarm(state);
                return response;
              } catch (error) {
                await ensureArrivalRegistrationRetryAlarm(state);
                throw error;
              }
            };
          },
        });
      };
    },
  });
  return { ...env, REGIONS: regions };
}

export class RegionDurableObject extends RegionWindowReliabilityRegionDurableObject {
  constructor(
    state: DurableObjectState,
    env: ArrivalRegistrationReliabilityEnv,
  ) {
    super(state, reliableArrivalRegistrationEnv(env, state));
  }
}

export default baseWorker;
