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

type ArrivalOwnerLookupStep =
  | { kind: "owned"; regionId: string }
  | { kind: "forwarded"; regionId: string }
  | { kind: "absent" }
  | { kind: "pending" }
  | { kind: "unknown" };

const PENDING_ARRIVAL_REGISTRATIONS_KEY =
  "handoff:autonomy:arrival-registration-retry:v1";
const INTERNAL_AGENT_LOOKUP_PATH = "/api/internal/autonomy/agent/lookup";
const MAX_ARRIVAL_OWNER_FORWARD_HOPS = 6;

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

    let regionId = registration.targetRegionId;
    for (let hop = 0; hop < MAX_ARRIVAL_OWNER_FORWARD_HOPS; hop += 1) {
      let response: Response;
      try {
        const stub = this.arrivalReconciliationEnv.REGIONS.get(
          this.arrivalReconciliationEnv.REGIONS.idFromName(regionId),
        );
        response = await stub.fetch(new Request(
          `https://moyo.internal${INTERNAL_AGENT_LOOKUP_PATH}?agentId=${encodeURIComponent(agentId)}`,
          { headers: { "x-moyo-region-internal": regionId } },
        ));
      } catch {
        return undefined;
      }
      if (!response.ok) return undefined;

      let body: unknown;
      try {
        body = await response.json() as unknown;
      } catch {
        return undefined;
      }
      const step = arrivalOwnerLookupStep(regionId, body);
      if (step.kind === "owned") return step.regionId;
      if (step.kind === "absent") return null;
      if (step.kind !== "forwarded") return undefined;
      regionId = step.regionId;
    }
    return undefined;
  }

  private async reconcilePendingArrivalTargets(): Promise<void> {
    const now = Date.now();
    const stored = await this.arrivalReconciliationState.storage.get<unknown>(
      PENDING_ARRIVAL_REGISTRATIONS_KEY,
    );
    const pending = normalizePendingArrivalRegistrations(stored, now);

    for (const registration of pending) {
      const ownerRegionId = await this.resolveArrivalOwner(registration);
      if (ownerRegionId === undefined) continue;

      const latest = await this.arrivalReconciliationState.storage.get<unknown>(
        PENDING_ARRIVAL_REGISTRATIONS_KEY,
      );
      if (ownerRegionId === null) {
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
    // current owner, then let the existing registration retry/release fence run.
    await this.reconcilePendingArrivalTargets();
    await super.alarm();
  }
}

export default baseWorker;
