from pathlib import Path

path = Path("src/autonomy-region.ts")
text = path.read_text()

old = '''    const now = Date.now();
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
'''
new = '''    const now = Date.now();
    const state = runtimeAccess(this).runtime.snapshot();
    const actualHeadroom = factionStorageCapacityLeft(state, body.factionId);
    const result = await this.autonomyState.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY);
      const reservations = Array.isArray(stored)
        ? stored
          .filter(isDestinationStorageReservation)
          .filter((entry) => entry.expiresAtMs > now)
        : [];
      const existing = reservations.find((entry) => entry.claimId === body.claimId);
      if (existing !== undefined) {
        if (
          existing.sourceRegionId !== body.sourceRegionId
          || existing.factionId !== body.factionId
        ) {
          return { conflict: true as const };
        }
        return {
          conflict: false as const,
          grantedAmount: existing.amount,
          remainingHeadroom: Math.max(
            0,
            actualHeadroom - reservations.reduce(
              (sum, entry) => entry.factionId === body.factionId ? sum + entry.amount : sum,
              0,
            ),
          ),
          idempotent: true,
        };
      }

      const alreadyReserved = reservations.reduce(
        (sum, entry) => entry.factionId === body.factionId ? sum + entry.amount : sum,
        0,
      );
      const available = Math.max(0, actualHeadroom - alreadyReserved);
      const grantedAmount = Math.min(body.amount, available);
      const next = grantedAmount > 0
        ? [...reservations, {
          claimId: body.claimId,
          sourceRegionId: body.sourceRegionId,
          factionId: body.factionId,
          amount: grantedAmount,
          expiresAtMs: now + DESTINATION_STORAGE_RESERVATION_TTL_MS,
        } satisfies AutonomousDestinationStorageReservation]
        : reservations;
      if (!Array.isArray(stored) || next.length !== stored.length || grantedAmount > 0) {
        await transaction.put(AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY, next);
      }
      return {
        conflict: false as const,
        grantedAmount,
        remainingHeadroom: Math.max(0, available - grantedAmount),
        idempotent: false,
      };
    });
    if (result.conflict) {
      return new Response(JSON.stringify({ error: "claimId already reserved by another source" }), {
        status: 409,
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      claimId: body.claimId,
      requestedAmount: body.amount,
      grantedAmount: result.grantedAmount,
      remainingHeadroom: result.remainingHeadroom,
      ...(result.idempotent ? { idempotent: true } : {}),
    }), { headers: { "content-type": "application/json; charset=utf-8" } });
'''
assert old in text, "reserve destination block not found"
text = text.replace(old, new, 1)

old = '''    const reservations = await this.activeDestinationStorageReservations();
    const next = reservations.filter((entry) =>
      entry.claimId !== body.claimId || entry.sourceRegionId !== body.sourceRegionId
    );
    if (next.length !== reservations.length) {
      await this.autonomyState.storage.put(
        AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY,
        next,
      );
    }
'''
new = '''    const now = Date.now();
    await this.autonomyState.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY);
      const reservations = Array.isArray(stored)
        ? stored
          .filter(isDestinationStorageReservation)
          .filter((entry) => entry.expiresAtMs > now)
        : [];
      const next = reservations.filter((entry) =>
        entry.claimId !== body.claimId || entry.sourceRegionId !== body.sourceRegionId
      );
      if (!Array.isArray(stored) || next.length !== stored.length) {
        await transaction.put(AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY, next);
      }
    });
'''
assert old in text, "release destination block not found"
text = text.replace(old, new, 1)
path.write_text(text)

test_path = Path("tests/autonomous-concurrent-travel-do.test.mjs")
tests = test_path.read_text()
old = '''  constructor() {
    this.values = new Map();
    this.alarm = null;
  }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async getAlarm() { return this.alarm; }
'''
new = '''  constructor() {
    this.values = new Map();
    this.alarm = null;
    this.transactionTail = Promise.resolve();
  }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async transaction(callback) {
    const previous = this.transactionTail;
    let release;
    this.transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback(this);
    } finally {
      release();
    }
  }
  async getAlarm() { return this.alarm; }
'''
assert old in tests, "MemoryStorage anchor not found"
tests = tests.replace(old, new, 1)

old = '''  assert.equal((await reserve("source-a", "garden-1", 2)).grantedAmount, 2);
  assert.equal((await reserve("source-b", "garden-3", 2)).grantedAmount, 1);
  assert.equal((await reserve("source-c", "garden-1", 1)).grantedAmount, 0);
  assert.equal((await reserve("source-a", "garden-1", 2)).grantedAmount, 2, "retry must be idempotent");

  const release = await destination.object.fetch(new Request(
'''
new = '''  const [sourceA, sourceB] = await Promise.all([
    reserve("source-a", "garden-1", 2),
    reserve("source-b", "garden-3", 2),
  ]);
  assert.deepEqual(
    [sourceA.grantedAmount, sourceB.grantedAmount].sort((left, right) => left - right),
    [1, 2],
    "concurrent source regions must share one atomic three-slot budget",
  );
  assert.equal((await reserve("source-c", "garden-1", 1)).grantedAmount, 0);
  assert.equal(
    (await reserve("source-a", "garden-1", 2)).grantedAmount,
    sourceA.grantedAmount,
    "retry must be idempotent",
  );

  const release = await destination.object.fetch(new Request(
'''
assert old in tests, "sequential destination admission assertions not found"
tests = tests.replace(old, new, 1)

old = '''  assert.equal(release.status, 200);
  assert.equal((await reserve("source-d", "garden-1", 2)).grantedAmount, 2);
  const reservations = await destination.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY);
'''
new = '''  assert.equal(release.status, 200);
  assert.equal(
    (await reserve("source-d", "garden-1", 2)).grantedAmount,
    sourceA.grantedAmount,
    "releasing one source must restore exactly its admitted capacity",
  );
  const reservations = await destination.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY);
'''
assert old in tests, "release assertion anchor not found"
tests = tests.replace(old, new, 1)
test_path.write_text(tests)
