import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSettlementFamilyAdmissionReservations,
  settlementFamilyReservedSlots,
  upsertSettlementFamilyAdmissionReservation,
} from "../dist-ts/src/settlement-family-reservation.js";

const reservation = (overrides = {}) => ({
  reservationId: "family:garden-1:pioneer-1:garden-2",
  sourceRegionId: "garden-1",
  pioneerId: "pioneer-1",
  factionId: "faction-a",
  agentIds: ["agent-global:garden-1:adult", "agent-global:garden-1:infant"],
  expiresAtMs: 20_000,
  ...overrides,
});

test("family reservations release arrived followers and expire stale promises", () => {
  const normalized = normalizeSettlementFamilyAdmissionReservations(
    [
      reservation(),
      reservation({ reservationId: "expired", agentIds: ["stale"], expiresAtMs: 9_000 }),
    ],
    new Set(["agent-global:garden-1:adult"]),
    10_000,
  );
  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.reservations, [
    reservation({ agentIds: ["agent-global:garden-1:infant"] }),
  ]);
});

test("family reservation retries are idempotent and shared capacity counts unique followers", () => {
  const first = reservation({ agentIds: ["agent-global:garden-1:adult"] });
  const retried = upsertSettlementFamilyAdmissionReservation([first], reservation({
    agentIds: ["agent-global:garden-1:adult", "agent-global:garden-1:infant"],
    expiresAtMs: 30_000,
  }));
  const duplicated = [
    ...retried,
    reservation({
      reservationId: "family:garden-1:pioneer-2:garden-2",
      pioneerId: "pioneer-2",
      agentIds: ["agent-global:garden-1:infant"],
      expiresAtMs: 30_000,
    }),
  ];
  assert.deepEqual(retried[0].agentIds, [
    "agent-global:garden-1:adult",
    "agent-global:garden-1:infant",
  ]);
  assert.equal(retried[0].expiresAtMs, 30_000);
  assert.equal(settlementFamilyReservedSlots(duplicated, "faction-a"), 2);
  assert.equal(settlementFamilyReservedSlots(duplicated, "faction-b"), 0);
});
