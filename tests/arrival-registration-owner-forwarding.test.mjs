import test from "node:test";
import assert from "node:assert/strict";

import {
  arrivalOwnerLookupStep,
  MAX_ARRIVAL_OWNER_FORWARD_HOPS,
  resolveArrivalOwnerRegion,
  retargetPendingArrivalRegistrations,
} from "../dist-ts/src/arrival-registration-region.js";
import {
  ARRIVAL_REGISTRATION_RETRY_TTL_MS,
  pendingArrivalRegistrationBlocksClaimRelease,
  upsertPendingArrivalRegistration,
} from "../dist-ts/src/storage-reservation-region.js";

const NOW = 2_000_000;
const CLAIM = "autonomy-claim:garden-1:agent-1:42:E:garden-2";

function failedRegistration(targetRegionId = "garden-2") {
  return {
    claimId: CLAIM,
    targetRegionId,
    payload: {
      claimId: CLAIM,
      sourceRegionId: "garden-1",
      agentId: "agent-global:garden-1:agent-1",
      resource: "wood",
      returnToSourceStorage: true,
    },
  };
}

test("arrival owner lookup follows committed handoff forwarding but waits on in-flight handoff", () => {
  assert.deepEqual(
    arrivalOwnerLookupStep("garden-2", { present: false, forwardedRegionId: "hex-q2-r0" }),
    { kind: "forwarded", regionId: "hex-q2-r0" },
  );
  assert.deepEqual(
    arrivalOwnerLookupStep("garden-2", { present: false, handoffPending: true }),
    { kind: "pending" },
  );
  assert.deepEqual(
    arrivalOwnerLookupStep("garden-2", { present: true }),
    { kind: "owned", regionId: "garden-2" },
  );
  assert.deepEqual(
    arrivalOwnerLookupStep("garden-2", { present: false }),
    { kind: "absent" },
  );
});

test("arrival owner resolution advances long forwarding chains without exceeding one alarm budget", async () => {
  const chainLength = MAX_ARRIVAL_OWNER_FORWARD_HOPS + 3;
  const lookups = [];
  const lookup = async (regionId) => {
    lookups.push(regionId);
    const index = Number(regionId.slice("hex-q".length).split("-r")[0]);
    if (index >= chainLength) return { present: true };
    return { present: false, forwardedRegionId: `hex-q${index + 1}-r0` };
  };

  const first = await resolveArrivalOwnerRegion("hex-q0-r0", lookup);
  assert.equal(first, `hex-q${MAX_ARRIVAL_OWNER_FORWARD_HOPS}-r0`);
  assert.equal(lookups.length, MAX_ARRIVAL_OWNER_FORWARD_HOPS);

  lookups.length = 0;
  const second = await resolveArrivalOwnerRegion(first, lookup);
  assert.equal(second, `hex-q${chainLength}-r0`);
  assert.ok(lookups.length <= MAX_ARRIVAL_OWNER_FORWARD_HOPS);
});

test("arrival owner resolution fails closed on cyclic or ambiguous forwarding", async () => {
  const cycle = new Map([
    ["garden-2", { present: false, forwardedRegionId: "garden-3" }],
    ["garden-3", { present: false, forwardedRegionId: "garden-2" }],
  ]);
  assert.equal(
    await resolveArrivalOwnerRegion("garden-2", async (regionId) => cycle.get(regionId)),
    undefined,
  );
  assert.equal(
    await resolveArrivalOwnerRegion("garden-2", async () => ({ present: false, handoffPending: true })),
    undefined,
  );
  assert.equal(
    await resolveArrivalOwnerRegion("garden-2", async () => ({ present: false })),
    null,
  );
});

test("retargeting an arrival retry preserves the bounded lease and release fence", () => {
  const pending = upsertPendingArrivalRegistration([], failedRegistration(), NOW);
  const originalExpiry = pending[0]?.expiresAtMs;
  assert.equal(originalExpiry, NOW + ARRIVAL_REGISTRATION_RETRY_TTL_MS);

  const retargeted = retargetPendingArrivalRegistrations(
    pending,
    CLAIM,
    "garden-2",
    "hex-q2-r0",
    NOW + 1,
  );

  assert.equal(retargeted.length, 1);
  assert.equal(retargeted[0]?.targetRegionId, "hex-q2-r0");
  assert.equal(retargeted[0]?.expiresAtMs, originalExpiry);
  assert.deepEqual(retargeted[0]?.payload, pending[0]?.payload);
  assert.equal(
    pendingArrivalRegistrationBlocksClaimRelease(retargeted, CLAIM, NOW + 2),
    true,
  );
  assert.equal(
    pendingArrivalRegistrationBlocksClaimRelease(
      retargeted,
      CLAIM,
      NOW + ARRIVAL_REGISTRATION_RETRY_TTL_MS + 1,
    ),
    false,
  );
});
