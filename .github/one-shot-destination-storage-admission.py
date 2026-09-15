from pathlib import Path

path = Path("src/autonomy-region.ts")
text = path.read_text()

old = '''interface AutonomousArrivalClaim {
  claimId: string;
  sourceRegionId: string;
  agentId: string;
  resource: ResourceKind;
  registeredAtTick: number;
  gatheredAmount?: number;
  settledAmount?: number;
  returnToSourceStorage?: boolean;
}

export interface AutonomousHaloHandoffPlan extends PendingAutonomousHandoff {
'''
new = '''interface AutonomousArrivalClaim {
  claimId: string;
  sourceRegionId: string;
  agentId: string;
  resource: ResourceKind;
  registeredAtTick: number;
  gatheredAmount?: number;
  settledAmount?: number;
  returnToSourceStorage?: boolean;
}

interface AutonomousDestinationStorageReservation {
  claimId: string;
  sourceRegionId: string;
  factionId: string;
  amount: number;
  expiresAtMs: number;
}

export interface AutonomousHaloHandoffPlan extends PendingAutonomousHandoff {
'''
assert old in text, "arrival claim interface anchor not found"
text = text.replace(old, new, 1)

old = '''const AUTONOMOUS_ARRIVAL_CLAIMS_KEY = "handoff:autonomy:arrival-claims:v1";
const AUTONOMOUS_SETTLEMENT_MIGRATION_KEY = "handoff:autonomy:settlement-migration:v1";
const INTERNAL_EDGE_PATH = "/api/internal/halo/edge";
const INTERNAL_AUTONOMY_PREFIX = "/api/internal/autonomy/";
const INTERNAL_CLAIM_REGISTER_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/register`;
const INTERNAL_CLAIM_SETTLE_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/settle`;
const INTERNAL_CLAIM_RELEASE_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/release`;
'''
new = '''const AUTONOMOUS_ARRIVAL_CLAIMS_KEY = "handoff:autonomy:arrival-claims:v1";
const AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY = "handoff:autonomy:destination-storage:v1";
const AUTONOMOUS_SETTLEMENT_MIGRATION_KEY = "handoff:autonomy:settlement-migration:v1";
const INTERNAL_EDGE_PATH = "/api/internal/halo/edge";
const INTERNAL_AUTONOMY_PREFIX = "/api/internal/autonomy/";
const INTERNAL_CLAIM_REGISTER_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/register`;
const INTERNAL_CLAIM_SETTLE_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/settle`;
const INTERNAL_CLAIM_RELEASE_PATH = `${INTERNAL_AUTONOMY_PREFIX}claim/release`;
const INTERNAL_STORAGE_RESERVE_PATH = `${INTERNAL_AUTONOMY_PREFIX}storage/reserve`;
const INTERNAL_STORAGE_RELEASE_PATH = `${INTERNAL_AUTONOMY_PREFIX}storage/release`;
'''
assert old in text, "autonomy constants anchor not found"
text = text.replace(old, new, 1)

old = '''const MAX_CONCURRENT_AUTONOMOUS_TRAVELS = 3;
const SETTLEMENT_MIGRATION_TTL = 72;
'''
new = '''const MAX_CONCURRENT_AUTONOMOUS_TRAVELS = 3;
// Destination admission uses wall-clock expiry because source and destination
// simulation ticks may advance at different active/warm/cold cadences.
const DESTINATION_STORAGE_RESERVATION_TTL_MS = 15 * 60 * 1_000;
const SETTLEMENT_MIGRATION_TTL = 72;
'''
assert old in text, "travel constants anchor not found"
text = text.replace(old, new, 1)

anchor = '''function inventoryAmount(agent: Agent): number {
'''
helper = '''function isDestinationStorageReservation(
  value: unknown,
): value is AutonomousDestinationStorageReservation {
  return isRecord(value)
    && typeof value.claimId === "string"
    && value.claimId.length > 0
    && typeof value.sourceRegionId === "string"
    && value.sourceRegionId.length > 0
    && typeof value.factionId === "string"
    && value.factionId.length > 0
    && typeof value.amount === "number"
    && Number.isFinite(value.amount)
    && value.amount > 0
    && typeof value.expiresAtMs === "number"
    && Number.isFinite(value.expiresAtMs)
    && value.expiresAtMs > 0;
}

'''
assert anchor in text, "inventoryAmount anchor not found"
text = text.replace(anchor, helper + anchor, 1)

old = '''  private async releaseAutonomousSupplyClaim(claimId: string | undefined): Promise<void> {
    if (claimId === undefined) return;
    const stored = await this.autonomyState.storage.get<unknown>(AUTONOMOUS_SUPPLY_CLAIMS_KEY);
    if (!Array.isArray(stored)) return;
    const next = stored
      .filter(isAutonomousSupplyClaim)
      .filter((claim) => claim.claimId !== claimId);
    if (next.length !== stored.length) {
      await this.autonomyState.storage.put(AUTONOMOUS_SUPPLY_CLAIMS_KEY, next);
    }
  }

  private async arrivalClaims(): Promise<AutonomousArrivalClaim[]> {
'''
new = '''  private async releaseRemoteDestinationStorageReservation(
    claim: AutonomousSupplyClaim | undefined,
  ): Promise<void> {
    if (claim?.destinationStorageReserved !== true) return;
    const sourceRegionId = runtimeAccess(this).runtime.snapshot().regionId;
    try {
      await this.autonomyStub(claim.neighborRegionId).fetch(new Request(
        `https://moyo.internal${INTERNAL_STORAGE_RELEASE_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-moyo-region-internal": claim.neighborRegionId,
          },
          body: JSON.stringify({ claimId: claim.claimId, sourceRegionId }),
        },
      ));
    } catch {
      // The destination-side wall-clock TTL is the crash-safe fallback. A
      // failed best-effort release can temporarily underbook, never overbook.
    }
  }

  private async releaseAutonomousSupplyClaim(claimId: string | undefined): Promise<void> {
    if (claimId === undefined) return;
    const stored = await this.autonomyState.storage.get<unknown>(AUTONOMOUS_SUPPLY_CLAIMS_KEY);
    if (!Array.isArray(stored)) return;
    const valid = stored.filter(isAutonomousSupplyClaim);
    const released = valid.find((claim) => claim.claimId === claimId);
    const next = valid.filter((claim) => claim.claimId !== claimId);
    if (next.length !== stored.length) {
      await this.autonomyState.storage.put(AUTONOMOUS_SUPPLY_CLAIMS_KEY, next);
    }
    await this.releaseRemoteDestinationStorageReservation(released);
  }

  private async arrivalClaims(): Promise<AutonomousArrivalClaim[]> {
'''
assert old in text, "releaseAutonomousSupplyClaim block not found"
text = text.replace(old, new, 1)

anchor = '''  private async ensureAutonomyAssigned(request: Request): Promise<Response | undefined> {
'''
methods = '''  private async activeDestinationStorageReservations(
    now = Date.now(),
  ): Promise<AutonomousDestinationStorageReservation[]> {
    const stored = await this.autonomyState.storage.get<unknown>(
      AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY,
    );
    const valid = Array.isArray(stored)
      ? stored.filter(isDestinationStorageReservation)
      : [];
    const active = valid.filter((entry) => entry.expiresAtMs > now);
    if (!Array.isArray(stored) || active.length !== stored.length) {
      await this.autonomyState.storage.put(
        AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY,
        active,
      );
    }
    return active;
  }

  private async reserveDestinationStorage(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "request body must be valid JSON" }), { status: 400 });
    }
    if (
      !isRecord(body)
      || typeof body.claimId !== "string"
      || body.claimId.trim() === ""
      || typeof body.sourceRegionId !== "string"
      || !isAutonomyClaimSourceRegionId(configuredRegionIds(this.autonomyEnv), body.sourceRegionId)
      || typeof body.factionId !== "string"
      || body.factionId.trim() === ""
      || typeof body.amount !== "number"
      || !Number.isFinite(body.amount)
      || body.amount <= 0
    ) {
      return new Response(JSON.stringify({ error: "invalid destination storage reservation" }), {
        status: 400,
      });
    }

    const now = Date.now();
    const reservations = await this.activeDestinationStorageReservations(now);
    const existing = reservations.find((entry) => entry.claimId === body.claimId);
    if (existing !== undefined) {
      if (
        existing.sourceRegionId !== body.sourceRegionId
        || existing.factionId !== body.factionId
      ) {
        return new Response(JSON.stringify({ error: "claimId already reserved by another source" }), {
          status: 409,
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        claimId: existing.claimId,
        grantedAmount: existing.amount,
        idempotent: true,
      }), { headers: { "content-type": "application/json; charset=utf-8" } });
    }

    const state = runtimeAccess(this).runtime.snapshot();
    const actualHeadroom = factionStorageCapacityLeft(state, body.factionId);
    const alreadyReserved = reservations.reduce(
      (sum, entry) => entry.factionId === body.factionId ? sum + entry.amount : sum,
      0,
    );
    const available = Math.max(0, actualHeadroom - alreadyReserved);
    const grantedAmount = Math.min(body.amount, available);
    if (grantedAmount > 0) {
      const reservation: AutonomousDestinationStorageReservation = {
        claimId: body.claimId,
        sourceRegionId: body.sourceRegionId,
        factionId: body.factionId,
        amount: grantedAmount,
        expiresAtMs: now + DESTINATION_STORAGE_RESERVATION_TTL_MS,
      };
      await this.autonomyState.storage.put(
        AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY,
        [...reservations, reservation],
      );
    }
    return new Response(JSON.stringify({
      ok: true,
      claimId: body.claimId,
      requestedAmount: body.amount,
      grantedAmount,
      remainingHeadroom: Math.max(0, available - grantedAmount),
    }), { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  private async releaseDestinationStorage(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "request body must be valid JSON" }), { status: 400 });
    }
    if (
      !isRecord(body)
      || typeof body.claimId !== "string"
      || body.claimId.trim() === ""
      || typeof body.sourceRegionId !== "string"
      || !isAutonomyClaimSourceRegionId(configuredRegionIds(this.autonomyEnv), body.sourceRegionId)
    ) {
      return new Response(JSON.stringify({ error: "claimId and sourceRegionId are required" }), {
        status: 400,
      });
    }
    const reservations = await this.activeDestinationStorageReservations();
    const next = reservations.filter((entry) =>
      entry.claimId !== body.claimId || entry.sourceRegionId !== body.sourceRegionId
    );
    if (next.length !== reservations.length) {
      await this.autonomyState.storage.put(
        AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY,
        next,
      );
    }
    return new Response(JSON.stringify({ ok: true, claimId: body.claimId }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

'''
assert anchor in text, "ensureAutonomyAssigned anchor not found"
text = text.replace(anchor, methods + anchor, 1)

anchor = '''  private async startAutonomousTravels(
'''
helper = '''  private async reserveRemoteDestinationStorage(
    state: WorldState,
    claimId: string,
    neighborRegionId: string,
    factionId: string,
    amount: number,
  ): Promise<number> {
    try {
      const response = await this.autonomyStub(neighborRegionId).fetch(new Request(
        `https://moyo.internal${INTERNAL_STORAGE_RESERVE_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-moyo-region-internal": neighborRegionId,
          },
          body: JSON.stringify({
            claimId,
            sourceRegionId: state.regionId,
            factionId,
            amount,
          }),
        },
      ));
      if (!response.ok) return 0;
      const payload = await response.json() as unknown;
      if (!isRecord(payload) || typeof payload.grantedAmount !== "number") return 0;
      if (!Number.isFinite(payload.grantedAmount) || payload.grantedAmount <= 0) return 0;
      return Math.min(amount, payload.grantedAmount);
    } catch {
      // A known remote-only sink must fail closed if its actual destination
      // admission cannot be confirmed. The next scout cadence can retry.
      return 0;
    }
  }

'''
assert anchor in text, "startAutonomousTravels anchor not found"
text = text.replace(anchor, helper + anchor, 1)

old = '''      const returnToSourceStorage = availableReturnStorage > 0;
      const destinationStorageReserved =
        !returnToSourceStorage
        && plan.destinationStorageHeadroom !== undefined
        && plan.destinationStorageHeadroom > 0;
      // A return reservation is a capacity promise, not just a boolean hint. Bound
      // the supply claim by still-unreserved source storage so concurrent scouts do
      // not all plan to deposit into the same final slots. When this expedition
      // instead relies on a concrete remote sink, reserve the observed destination
      // headroom within this source DO so later scouts cannot overbook it.
      const claimedSupply = returnToSourceStorage
        ? Math.min(plannedSupply, availableReturnStorage)
        : destinationStorageReserved
          ? Math.min(plannedSupply, plan.destinationStorageHeadroom ?? plannedSupply)
          : plannedSupply;
'''
new = '''      const returnToSourceStorage = availableReturnStorage > 0;
      const needsDestinationReservation =
        !returnToSourceStorage
        && plan.destinationStorageHeadroom !== undefined
        && plan.destinationStorageHeadroom > 0;
      let destinationStorageReserved = false;
      // Source-return capacity remains a local promise. If this expedition
      // depends on a concrete remote sink, ask the destination DO to admit the
      // claim against current storage plus reservations from every source DO.
      let claimedSupply = returnToSourceStorage
        ? Math.min(plannedSupply, availableReturnStorage)
        : plannedSupply;
      if (needsDestinationReservation) {
        const requestedRemoteStorage = Math.min(
          plannedSupply,
          plan.destinationStorageHeadroom ?? plannedSupply,
        );
        claimedSupply = await this.reserveRemoteDestinationStorage(
          state,
          claimId,
          plan.neighborRegionId,
          agent.factionId,
          requestedRemoteStorage,
        );
        destinationStorageReserved = claimedSupply > 0;
        if (!destinationStorageReserved) break;
      }
'''
assert old in text, "source-local destination reservation block not found"
text = text.replace(old, new, 1)

old = '''    if (request.method === "POST" && url.pathname === INTERNAL_CLAIM_REGISTER_PATH) {
      return this.registerArrivalClaim(request);
    }
'''
new = '''    if (request.method === "POST" && url.pathname === INTERNAL_STORAGE_RESERVE_PATH) {
      return this.reserveDestinationStorage(request);
    }
    if (request.method === "POST" && url.pathname === INTERNAL_STORAGE_RELEASE_PATH) {
      return this.releaseDestinationStorage(request);
    }
    if (request.method === "POST" && url.pathname === INTERNAL_CLAIM_REGISTER_PATH) {
      return this.registerArrivalClaim(request);
    }
'''
assert old in text, "fetchAutonomyRequest routing anchor not found"
text = text.replace(old, new, 1)

path.write_text(text)

test_path = Path("tests/autonomous-concurrent-travel-do.test.mjs")
tests = test_path.read_text()
old = 'const ARRIVAL_CLAIMS_KEY = "handoff:autonomy:arrival-claims:v1";\n'
new = old + 'const DESTINATION_STORAGE_RESERVATIONS_KEY = "handoff:autonomy:destination-storage:v1";\n'
assert old in tests, "test constants anchor not found"
tests = tests.replace(old, new, 1)

old = '''  assert.ok(claims.every((claim) => claim.destinationStorageReserved === true));
  assert.ok(claims.every((claim) => claim.sourceFactionId === scout.factionId));
});
'''
new = '''  assert.ok(claims.every((claim) => claim.destinationStorageReserved === true));
  assert.ok(claims.every((claim) => claim.sourceFactionId === scout.factionId));
  const remoteReservations = await east.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY);
  assert.equal(remoteReservations.length, 2);
  assert.equal(remoteReservations.reduce((sum, entry) => sum + entry.amount, 0), 3);
  assert.ok(remoteReservations.every((entry) => entry.sourceRegionId === "garden-1"));
});
'''
assert old in tests, "remote reservation integration assertion anchor not found"
tests = tests.replace(old, new, 1)

addition = r'''

test("destination storage admission is shared across source regions and releases idempotently", async () => {
  const env = environment();
  const destination = await assignRegion(env, "garden-2");
  const state = destination.object.runtime.snapshot();
  const factionId = state.agents[0]?.factionId;
  assert.ok(factionId);

  for (const structure of state.structures) {
    if (structure.factionId !== factionId || structure.status !== "active") continue;
    structure.storage = {
      wood: BUILD_RECIPES[structure.type].storageCapacity,
      stone: 0,
      food: 0,
    };
  }
  state.structures.push({
    id: "three-slot-shared-destination-storehouse",
    factionId,
    type: "storehouse",
    position: hexGridCenter(state),
    status: "active",
    progress: 1,
    requiredProgress: 1,
    storage: { wood: BUILD_RECIPES.storehouse.storageCapacity - 3, stone: 0, food: 0 },
  });
  destination.object.runtime = new WorldRuntime({ state });
  await destination.object.persist();

  const reserve = async (claimId, sourceRegionId, amount) => {
    const response = await destination.object.fetch(new Request(
      "https://moyo.internal/api/internal/autonomy/storage/reserve",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-moyo-region-internal": "garden-2",
        },
        body: JSON.stringify({ claimId, sourceRegionId, factionId, amount }),
      },
    ));
    assert.equal(response.status, 200);
    return response.json();
  };

  assert.equal((await reserve("source-a", "garden-1", 2)).grantedAmount, 2);
  assert.equal((await reserve("source-b", "garden-3", 2)).grantedAmount, 1);
  assert.equal((await reserve("source-c", "garden-1", 1)).grantedAmount, 0);
  assert.equal((await reserve("source-a", "garden-1", 2)).grantedAmount, 2, "retry must be idempotent");

  const release = await destination.object.fetch(new Request(
    "https://moyo.internal/api/internal/autonomy/storage/release",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-moyo-region-internal": "garden-2",
      },
      body: JSON.stringify({ claimId: "source-a", sourceRegionId: "garden-1" }),
    },
  ));
  assert.equal(release.status, 200);
  assert.equal((await reserve("source-d", "garden-1", 2)).grantedAmount, 2);
  const reservations = await destination.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY);
  assert.equal(reservations.reduce((sum, entry) => sum + entry.amount, 0), 3);
});
'''
assert "destination storage admission is shared across source regions" not in tests
test_path.write_text(tests + addition)
