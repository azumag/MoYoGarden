import baseWorker from "./worker-entry.js";
import {
  clearPendingArrivalRegistration,
  normalizePendingArrivalRegistrations,
  RegionDurableObject as StorageReservationRegionDurableObject,
  type PendingArrivalRegistration,
} from "./storage-reservation-region.js";

interface ArrivalReconciliationEnv {
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

export type ArrivalOwnerLookupStep =
  | { kind: "owned"; regionId: string }
  | { kind: "forwarded"; regionId: string }
  | { kind: "absent" }
  | { kind: "pending" }
  | { kind: "unknown" };

const PENDING_ARRIVAL_REGISTRATIONS_KEY =
  "handoff:autonomy:arrival-registration-retry:v1";
const INTERNAL_AGENT_LOOKUP_PATH = "/api/internal/autonomy/agent/lookup";
export const MAX_ARRIVAL_OWNER_FORWARD_HOPS = 6;
export const ARRIVAL_OWNER_LOOKUP_INTERVAL_MS = 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRegionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(normalized) ? normalized : undefined;
}

function pendingArrivalAgentId(registration: PendingArrivalRegistration): string | undefined {
  const agentId = registration.payload.agentId;
  return typeof agentId === "string" && agentId.startsWith("agent-global:")
    ? agentId
    : undefined;
}

function arrivalOwnerLookupKey(
  registration: Pick<PendingArrivalRegistration, "claimId" | "targetRegionId">,
): string {
  return `${registration.targetRegionId}\u0000${registration.claimId}`;
}

export class ArrivalOwnerLookupThrottle {
  private readonly nextLookupAtMs = new Map<string, number>();

  shouldLookup(
    registration: Pick<PendingArrivalRegistration, "claimId" | "targetRegionId">,
    now = Date.now(),
  ): boolean {
    const key = arrivalOwnerLookupKey(registration);
    const nextLookupAtMs = this.nextLookupAtMs.get(key) ?? 0;
    if (nextLookupAtMs > now) return false;
    this.nextLookupAtMs.set(key, now + ARRIVAL_OWNER_LOOKUP_INTERVAL_MS);
    return true;
  }

  forget(
    registration: Pick<PendingArrivalRegistration, "claimId" | "targetRegionId">,
  ): void {
    this.nextLookupAtMs.delete(arrivalOwnerLookupKey(registration));
  }
}

export function arrivalOwnerLookupStep(
  currentRegionId: string,
  value: unknown,
): ArrivalOwnerLookupStep {
  if (!isRecord(value) || typeof value.present !== "boolean") return { kind: "unknown" };
  if (value.present) return { kind: "owned", regionId: currentRegionId };
  if (value.handoffPending === true) return { kind: "pending" };
  const forwardedRegionId = validRegionId(value.forwardedRegionId);
  if (forwardedRegionId === undefined) return { kind: "absent" };
  if (forwardedRegionId === currentRegionId) return { kind: "unknown" };
  return { kind: "forwarded", regionId: forwardedRegionId };
}

export async function resolveArrivalOwnerRegion(
  initialRegionId: string,
  lookup: (regionId: string) => Promise<unknown>,
  maxForwardHops = MAX_ARRIVAL_OWNER_FORWARD_HOPS,
): Promise<string | null | undefined> {
  const hopLimit = Number.isFinite(maxForwardHops)
    ? Math.max(0, Math.floor(maxForwardHops))
    : MAX_ARRIVAL_OWNER_FORWARD_HOPS;
  if (hopLimit <= 0) return undefined;

  let regionId = initialRegionId;
  const visited = new Set<string>();
  for (let hop = 0; hop < hopLimit; hop += 1) {
    if (visited.has(regionId)) return undefined;
    visited.add(regionId);

    let value: unknown;
    try {
      value = await lookup(regionId);
    } catch {
      return undefined;
    }

    const step = arrivalOwnerLookupStep(regionId, value);
    if (step.kind === "owned") return step.regionId;
    if (step.kind === "absent") return null;
    if (step.kind !== "forwarded") return undefined;
    if (visited.has(step.regionId)) return undefined;
    regionId = step.regionId;
  }

  // Keep cross-DO work bounded per alarm, but do not stall a valid courier that
  // moved farther than the lookup budget before its arrival claim was ACKed.
  // Every forwarding hop above was proven by the crash-safe handoff directory,
  // so moving the retry cursor to the last proven region is safe even when that
  // region has itself already forwarded the agent. The next alarm can continue
  // from there instead of replaying the same first six hops until the lease dies.
  return regionId === initialRegionId ? undefined : regionId;
}

export function retargetPendingArrivalRegistrations(
  value: unknown,
  claimId: string,
  fromRegionId: string,
  toRegionId: string,
  now = Date.now(),
): PendingArrivalRegistration[] {
  const retargeted = normalizePendingArrivalRegistrations(value, now).map((entry) =>
    entry.claimId === claimId && entry.targetRegionId === fromRegionId
      ? {
          ...entry,
          targetRegionId: toRegionId,
          payload: { ...entry.payload },
        }
      : entry
  );
  return normalizePendingArrivalRegistrations(retargeted, now);
}

export class RegionDurableObject extends StorageReservationRegionDurableObject {
  private readonly arrivalOwnerLookupThrottle = new ArrivalOwnerLookupThrottle();

  constructor(
    private readonly arrivalReconciliationState: DurableObjectState,
    private readonly arrivalReconciliationEnv: ArrivalReconciliationEnv,
  ) {
    super(arrivalReconciliationState, arrivalReconciliationEnv);
  }

  private async resolveArrivalOwner(
    registration: PendingArrivalRegistration,
  ): Promise<string | null | undefined> {
    const agentId = pendingArrivalAgentId(registration);
    if (agentId === undefined) return undefined;

    return resolveArrivalOwnerRegion(registration.targetRegionId, async (regionId) => {
      const stub = this.arrivalReconciliationEnv.REGIONS.get(
        this.arrivalReconciliationEnv.REGIONS.idFromName(regionId),
      );
      const response = await stub.fetch(new Request(
        `https://moyo.internal${INTERNAL_AGENT_LOOKUP_PATH}?agentId=${encodeURIComponent(agentId)}`,
        { headers: { "x-moyo-region-internal": regionId } },
      ));
      if (!response.ok) throw new Error(`arrival owner lookup HTTP ${response.status}`);
      return response.json() as Promise<unknown>;
    });
  }

  private async reconcilePendingArrivalTargets(): Promise<void> {
    const now = Date.now();
    const stored = await this.arrivalReconciliationState.storage.get<unknown>(
      PENDING_ARRIVAL_REGISTRATIONS_KEY,
    );
    const pending = normalizePendingArrivalRegistrations(stored, now);

    for (const registration of pending) {
      // Registration retry itself remains on the normal alarm cadence. Directory
      // chasing is only needed when ownership may have moved, so cap unchanged
      // target lookups to once per minute. Active regions otherwise doubled the
      // cross-DO failure traffic (lookup + retry) every 10 seconds for up to 6h.
      // Retargeting forgets the old key so long forwarding chains can still make
      // another bounded hop-budget of progress on the very next alarm.
      if (!this.arrivalOwnerLookupThrottle.shouldLookup(registration, now)) continue;
      const ownerRegionId = await this.resolveArrivalOwner(registration);
      if (ownerRegionId === undefined) continue;

      const latest = await this.arrivalReconciliationState.storage.get<unknown>(
        PENDING_ARRIVAL_REGISTRATIONS_KEY,
      );
      if (ownerRegionId === null) {
        this.arrivalOwnerLookupThrottle.forget(registration);
        const next = clearPendingArrivalRegistration(
          latest,
          registration.targetRegionId,
          registration.claimId,
          now,
        );
        if (JSON.stringify(next) !== JSON.stringify(normalizePendingArrivalRegistrations(latest, now))) {
          await this.arrivalReconciliationState.storage.put(PENDING_ARRIVAL_REGISTRATIONS_KEY, next);
        }
        continue;
      }
      if (ownerRegionId === registration.targetRegionId) continue;

      this.arrivalOwnerLookupThrottle.forget(registration);
      const next = retargetPendingArrivalRegistrations(
        latest,
        registration.claimId,
        registration.targetRegionId,
        ownerRegionId,
        now,
      );
      if (JSON.stringify(next) !== JSON.stringify(normalizePendingArrivalRegistrations(latest, now))) {
        await this.arrivalReconciliationState.storage.put(PENDING_ARRIVAL_REGISTRATIONS_KEY, next);
      }
    }
  }

  override async alarm(): Promise<void> {
    // A material handoff can commit and then fail to install its arrival claim.
    // If that courier moves onward before the retry succeeds, the old target will
    // correctly answer 409 forever because it no longer owns the BOT. Follow the
    // crash-safe handoff directory first, retarget the bounded retry to the
    // current owner (or the farthest owner proven within this alarm's hop budget),
    // then let the existing registration retry/release fence run.
    await this.reconcilePendingArrivalTargets();
    await super.alarm();
  }
}

export default baseWorker;
