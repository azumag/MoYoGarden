import test from "node:test";
import assert from "node:assert/strict";

import {
  ARRIVAL_REGISTRATION_TERMINAL_GRACE_MS,
  beginArrivalTerminalGrace,
  finishArrivalTerminalReconciliation,
  normalizeArrivalTerminalMarkers,
  pendingArrivalRegistrationsIncludingExpired,
} from "../dist-ts/src/arrival-terminal-reconciliation.js";
import {
  ARRIVAL_REGISTRATION_RETRY_TTL_MS,
  pendingArrivalRegistrationBlocksClaimRelease,
  upsertPendingArrivalRegistration,
} from "../dist-ts/src/storage-reservation-region.js";

const NOW = 1_000_000;
const CLAIM = "autonomy-claim:garden-1:agent-1:42:E:garden-2";

function failedRegistration(claimId = CLAIM, targetRegionId = "garden-2") {
  return {
    claimId,
    targetRegionId,
    payload: {
      claimId,
      sourceRegionId: "garden-1",
      agentId: "agent-global:garden-1:agent-1",
      resource: "wood",
      returnToSourceStorage: true,
    },
  };
}

test("terminal reconciliation can inspect an arrival retry after its normal six-hour lease expires", () => {
  const pending = upsertPendingArrivalRegistration([], failedRegistration(), NOW);
  const expiredAt = NOW + ARRIVAL_REGISTRATION_RETRY_TTL_MS + 1;

  assert.equal(pendingArrivalRegistrationBlocksClaimRelease(pending, CLAIM, expiredAt), false);
  const raw = pendingArrivalRegistrationsIncludingExpired(pending);
  assert.equal(raw.length, 1);
  assert.equal(raw[0]?.claimId, CLAIM);
  assert.equal(raw[0]?.targetRegionId, "garden-2");
});

test("terminal reconciliation grants exactly one short release fence on the proven current owner", () => {
  const pending = upsertPendingArrivalRegistration([], failedRegistration(), NOW);
  const expiredAt = NOW + ARRIVAL_REGISTRATION_RETRY_TTL_MS + 1;
  const [registration] = pendingArrivalRegistrationsIncludingExpired(pending);
  assert.ok(registration);

  const terminal = beginArrivalTerminalGrace(
    pending,
    [],
    registration,
    "garden-4",
    expiredAt,
  );

  assert.equal(terminal.pending.length, 1);
  assert.equal(terminal.pending[0]?.targetRegionId, "garden-4");
  assert.equal(
    terminal.pending[0]?.expiresAtMs,
    expiredAt + ARRIVAL_REGISTRATION_TERMINAL_GRACE_MS,
  );
  assert.deepEqual(terminal.markers, [{
    claimId: CLAIM,
    terminalExpiresAtMs: expiredAt + ARRIVAL_REGISTRATION_TERMINAL_GRACE_MS,
  }]);
  assert.equal(
    pendingArrivalRegistrationBlocksClaimRelease(terminal.pending, CLAIM, expiredAt + 1),
    true,
  );

  const finished = finishArrivalTerminalReconciliation(
    terminal.pending,
    terminal.markers,
    CLAIM,
    expiredAt + ARRIVAL_REGISTRATION_TERMINAL_GRACE_MS + 1,
  );
  assert.deepEqual(finished.pending, []);
  assert.deepEqual(finished.markers, []);
  assert.equal(
    pendingArrivalRegistrationBlocksClaimRelease(
      finished.pending,
      CLAIM,
      expiredAt + ARRIVAL_REGISTRATION_TERMINAL_GRACE_MS + 1,
    ),
    false,
  );
});

test("terminal marker normalization is claim-scoped and does not extend the grace", () => {
  const normalized = normalizeArrivalTerminalMarkers([
    { claimId: CLAIM, terminalExpiresAtMs: NOW + 100 },
    { claimId: CLAIM, terminalExpiresAtMs: NOW + 50 },
    { claimId: `${CLAIM}:other`, terminalExpiresAtMs: NOW + 75 },
    { claimId: "broken", terminalExpiresAtMs: 0 },
  ]);

  assert.deepEqual(normalized, [
    { claimId: CLAIM, terminalExpiresAtMs: NOW + 100 },
    { claimId: `${CLAIM}:other`, terminalExpiresAtMs: NOW + 75 },
  ]);
});

test("starting terminal grace preserves unrelated active arrival retries", () => {
  const secondClaim = `${CLAIM}:second`;
  const first = upsertPendingArrivalRegistration([], failedRegistration(), NOW);
  const withSecond = upsertPendingArrivalRegistration(
    first,
    failedRegistration(secondClaim, "garden-3"),
    NOW + ARRIVAL_REGISTRATION_RETRY_TTL_MS - 100,
  );
  const expiredAt = NOW + ARRIVAL_REGISTRATION_RETRY_TTL_MS + 1;
  const [expired] = pendingArrivalRegistrationsIncludingExpired(withSecond)
    .filter((entry) => entry.claimId === CLAIM);
  assert.ok(expired);

  const terminal = beginArrivalTerminalGrace(
    withSecond,
    [],
    expired,
    "garden-4",
    expiredAt,
  );

  assert.equal(terminal.pending.length, 2);
  assert.equal(terminal.pending.some((entry) => entry.claimId === secondClaim), true);
  assert.equal(terminal.pending.some((entry) =>
    entry.claimId === CLAIM && entry.targetRegionId === "garden-4"
  ), true);
});
