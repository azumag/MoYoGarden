import baseWorker, {
  RegionDurableObject as ArrivalRegistrationRegionDurableObject,
} from "./arrival-registration-region.js";

interface StorageReleaseRetryEnv {
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

export interface PendingDestinationStorageRelease {
  claimId: string;
  sourceRegionId: string;
  targetRegionId: string;
  releaseIssuedAtMs: number;
  expiresAtMs: number;
}

const INTERNAL_STORAGE_RELEASE_PATH = "/api/internal/autonomy/storage/release";
const PENDING_DESTINATION_STORAGE_RELEASES_KEY =
  "handoff:autonomy:destination-storage-release-retry:v1";
export const DESTINATION_STORAGE_RELEASE_RETRY_TTL_MS = 30 * 60 * 1_000;
export const DESTINATION_STORAGE_RELEASE_RETRY_INTERVAL_MS = 60 * 1_000;
export const DESTINATION_STORAGE_RELEASE_RETRY_TIMEOUT_MS = 5_000;
export const DESTINATION_STORAGE_RELEASE_RETRY_ATTEMPT_BUDGET = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function validRegionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(normalized) ? normalized : undefined;
}

function releaseKey(
  entry: Pick<PendingDestinationStorageRelease, "claimId" | "sourceRegionId" | "targetRegionId">,
): string {
  return `${entry.targetRegionId}\u0000${entry.sourceRegionId}\u0000${entry.claimId}`;
}

function isPendingDestinationStorageRelease(
  value: unknown,
): value is PendingDestinationStorageRelease {
  return isRecord(value)
    && typeof value.claimId === "string"
    && value.claimId.length > 0
    && validRegionId(value.sourceRegionId) !== undefined
    && validRegionId(value.targetRegionId) !== undefined
    && positiveFinite(value.releaseIssuedAtMs) !== undefined
    && positiveFinite(value.expiresAtMs) !== undefined;
}

export function normalizePendingDestinationStorageReleases(
  value: unknown,
  now = Date.now(),
): PendingDestinationStorageRelease[] {
  if (!Array.isArray(value)) return [];
  const merged = new Map<string, PendingDestinationStorageRelease>();
  for (const candidate of value) {
    if (!isPendingDestinationStorageRelease(candidate) || candidate.expiresAtMs <= now) continue;
    const key = releaseKey(candidate);
    const current = merged.get(key);
    if (
      current === undefined
      || candidate.releaseIssuedAtMs > current.releaseIssuedAtMs
      || (
        candidate.releaseIssuedAtMs === current.releaseIssuedAtMs
        && candidate.expiresAtMs > current.expiresAtMs
      )
    ) {
      merged.set(key, { ...candidate });
    }
  }
  return [...merged.values()].sort((a, b) =>
    a.targetRegionId.localeCompare(b.targetRegionId)
    || a.sourceRegionId.localeCompare(b.sourceRegionId)
    || a.claimId.localeCompare(b.claimId)
    || a.releaseIssuedAtMs - b.releaseIssuedAtMs
  );
}

export function upsertPendingDestinationStorageRelease(
  value: unknown,
  release: Omit<PendingDestinationStorageRelease, "expiresAtMs">,
  now = Date.now(),
): PendingDestinationStorageRelease[] {
  const records = normalizePendingDestinationStorageReleases(value, now);
  const key = releaseKey(release);
  const existing = records.find((entry) => releaseKey(entry) === key);
  if (existing !== undefined && existing.releaseIssuedAtMs > release.releaseIssuedAtMs) {
    return records;
  }
  const next: PendingDestinationStorageRelease = {
    ...release,
    expiresAtMs: now + DESTINATION_STORAGE_RELEASE_RETRY_TTL_MS,
  };
  return [
    ...records.filter((entry) => releaseKey(entry) !== key),
    next,
  ].sort((a, b) =>
    a.targetRegionId.localeCompare(b.targetRegionId)
    || a.sourceRegionId.localeCompare(b.sourceRegionId)
    || a.claimId.localeCompare(b.claimId)
    || a.releaseIssuedAtMs - b.releaseIssuedAtMs
  );
}

export function clearPendingDestinationStorageRelease(
  value: unknown,
  targetRegionId: string,
  sourceRegionId: string,
  claimId: string,
  acknowledgedReleaseIssuedAtMs: number,
  now = Date.now(),
): PendingDestinationStorageRelease[] {
  return normalizePendingDestinationStorageReleases(value, now).filter((entry) =>
    entry.targetRegionId !== targetRegionId
    || entry.sourceRegionId !== sourceRegionId
    || entry.claimId !== claimId
    || entry.releaseIssuedAtMs > acknowledgedReleaseIssuedAtMs
  );
}

export function isRetryableDestinationStorageReleaseStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function withDestinationStorageReleaseDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DESTINATION_STORAGE_RELEASE_RETRY_TIMEOUT_MS,
): Promise<T> {
  const boundedTimeout = Math.max(1, Math.min(60_000, Math.floor(timeoutMs)));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`destination storage release exceeded ${boundedTimeout}ms`);
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

function pendingReleaseFromRequest(
  request: Request,
  body: Record<string, unknown>,
): Omit<PendingDestinationStorageRelease, "expiresAtMs"> | undefined {
  const targetRegionId = validRegionId(request.headers.get("x-moyo-region-internal"));
  const sourceRegionId = validRegionId(body.sourceRegionId);
  const claimId = typeof body.claimId === "string" ? body.claimId.trim() : "";
  const releaseIssuedAtMs = positiveFinite(body.releaseIssuedAtMs);
  if (
    targetRegionId === undefined
    || sourceRegionId === undefined
    || claimId === ""
    || releaseIssuedAtMs === undefined
  ) return undefined;
  return { claimId, sourceRegionId, targetRegionId, releaseIssuedAtMs };
}

class DestinationStorageReleaseRetryJournal {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly state: DurableObjectState) {}

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async pending(now = Date.now()): Promise<PendingDestinationStorageRelease[]> {
    return this.run(async () => normalizePendingDestinationStorageReleases(
      await this.state.storage.get<unknown>(PENDING_DESTINATION_STORAGE_RELEASES_KEY),
      now,
    ));
  }

  async remember(
    release: Omit<PendingDestinationStorageRelease, "expiresAtMs">,
    now = Date.now(),
  ): Promise<void> {
    await this.run(async () => {
      const stored = await this.state.storage.get<unknown>(PENDING_DESTINATION_STORAGE_RELEASES_KEY);
      await this.state.storage.put(
        PENDING_DESTINATION_STORAGE_RELEASES_KEY,
        upsertPendingDestinationStorageRelease(stored, release, now),
      );
    });
    await this.ensureRetryAlarm(now);
  }

  async acknowledge(
    release: Omit<PendingDestinationStorageRelease, "expiresAtMs">,
    now = Date.now(),
  ): Promise<void> {
    await this.run(async () => {
      const stored = await this.state.storage.get<unknown>(PENDING_DESTINATION_STORAGE_RELEASES_KEY);
      if (stored === undefined) return;
      const next = clearPendingDestinationStorageRelease(
        stored,
        release.targetRegionId,
        release.sourceRegionId,
        release.claimId,
        release.releaseIssuedAtMs,
        now,
      );
      const current = normalizePendingDestinationStorageReleases(stored, now);
      if (JSON.stringify(next) !== JSON.stringify(current) || !Array.isArray(stored)) {
        await this.state.storage.put(PENDING_DESTINATION_STORAGE_RELEASES_KEY, next);
      }
    });
  }

  async reconcile(
    completed: readonly Omit<PendingDestinationStorageRelease, "expiresAtMs">[],
    now = Date.now(),
  ): Promise<PendingDestinationStorageRelease[]> {
    return this.run(async () => {
      const stored = await this.state.storage.get<unknown>(PENDING_DESTINATION_STORAGE_RELEASES_KEY);
      let next: unknown = stored;
      for (const release of completed) {
        next = clearPendingDestinationStorageRelease(
          next,
          release.targetRegionId,
          release.sourceRegionId,
          release.claimId,
          release.releaseIssuedAtMs,
          now,
        );
      }
      const normalized = normalizePendingDestinationStorageReleases(next, now);
      const current = normalizePendingDestinationStorageReleases(stored, now);
      if (
        !Array.isArray(stored)
        || normalized.length !== current.length
        || JSON.stringify(normalized) !== JSON.stringify(current)
        || (Array.isArray(stored) && stored.length !== current.length)
      ) {
        await this.state.storage.put(PENDING_DESTINATION_STORAGE_RELEASES_KEY, normalized);
      }
      return normalized;
    });
  }

  async ensureRetryAlarm(now = Date.now()): Promise<void> {
    const retryAtMs = now + DESTINATION_STORAGE_RELEASE_RETRY_INTERVAL_MS;
    const current = await this.state.storage.getAlarm();
    if (current === null || current > retryAtMs) {
      await this.state.storage.setAlarm(retryAtMs);
    }
  }
}

function destinationStorageReleaseRetryEnv(
  env: StorageReleaseRetryEnv,
  journal: DestinationStorageReleaseRetryJournal,
): StorageReleaseRetryEnv {
  const regions = new Proxy(env.REGIONS, {
    get(target, property, receiver) {
      if (property !== "get") return Reflect.get(target, property, receiver);
      return (...getArgs: Parameters<StorageReleaseRetryEnv["REGIONS"]["get"]>) => {
        const stub = target.get(...getArgs);
        return new Proxy(stub, {
          get(stubTarget, stubProperty, stubReceiver) {
            if (stubProperty !== "fetch") {
              return Reflect.get(stubTarget, stubProperty, stubReceiver);
            }
            return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
              const request = new Request(input, init);
              const url = new URL(request.url);
              if (request.method !== "POST" || url.pathname !== INTERNAL_STORAGE_RELEASE_PATH) {
                return stub.fetch(request);
              }

              let body: unknown;
              try {
                body = await request.clone().json() as unknown;
              } catch {
                return stub.fetch(request);
              }
              if (!isRecord(body)) return stub.fetch(request);
              const release = pendingReleaseFromRequest(request, body);
              if (release === undefined) return stub.fetch(request);

              try {
                const response = await stub.fetch(request);
                if (response.ok || !isRetryableDestinationStorageReleaseStatus(response.status)) {
                  await journal.acknowledge(release);
                } else {
                  await journal.remember(release);
                }
                return response;
              } catch (error) {
                await journal.remember(release);
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

export class RegionDurableObject extends ArrivalRegistrationRegionDurableObject {
  private readonly releaseRetryJournal: DestinationStorageReleaseRetryJournal;
  private readonly releaseRetryDirectEnv: StorageReleaseRetryEnv;

  constructor(
    state: DurableObjectState,
    env: StorageReleaseRetryEnv,
  ) {
    const journal = new DestinationStorageReleaseRetryJournal(state);
    super(state, destinationStorageReleaseRetryEnv(env, journal));
    this.releaseRetryJournal = journal;
    this.releaseRetryDirectEnv = env;
  }

  private async retryPendingDestinationStorageReleases(): Promise<void> {
    const now = Date.now();
    const pending = await this.releaseRetryJournal.pending(now);
    if (pending.length === 0) {
      await this.releaseRetryJournal.reconcile([], now);
      return;
    }

    const attempts = pending.slice(0, DESTINATION_STORAGE_RELEASE_RETRY_ATTEMPT_BUDGET);
    const completed = (
      await Promise.all(attempts.map(async (release) => {
        try {
          const stub = this.releaseRetryDirectEnv.REGIONS.get(
            this.releaseRetryDirectEnv.REGIONS.idFromName(release.targetRegionId),
          );
          const response = await withDestinationStorageReleaseDeadline((signal) =>
            stub.fetch(new Request(
              `https://moyo.internal${INTERNAL_STORAGE_RELEASE_PATH}`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-moyo-region-internal": release.targetRegionId,
                },
                body: JSON.stringify({
                  claimId: release.claimId,
                  sourceRegionId: release.sourceRegionId,
                  releaseIssuedAtMs: release.releaseIssuedAtMs,
                }),
                signal,
              },
            ))
          );
          return response.ok || !isRetryableDestinationStorageReleaseStatus(response.status)
            ? release
            : undefined;
        } catch {
          return undefined;
        }
      }))
    ).filter((entry): entry is PendingDestinationStorageRelease => entry !== undefined);

    const remaining = await this.releaseRetryJournal.reconcile(completed, Date.now());
    if (remaining.length > 0) {
      await this.releaseRetryJournal.ensureRetryAlarm(Date.now());
    }
  }

  override async alarm(): Promise<void> {
    // Drain releases that failed before this Alarm first, then run the normal
    // simulation. Retry once more afterwards because source-claim cleanup inside
    // super.alarm() can create a new failed remote release and the parent may
    // deep-idle the region before another Alarm would otherwise be scheduled.
    await this.retryPendingDestinationStorageReleases();
    await super.alarm();
    await this.retryPendingDestinationStorageReleases();
  }
}

export default baseWorker;