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
  assert.deepEqual(retried[0].agentExpiresAtMs, {
    "agent-global:garden-1:adult": 30_000,
    "agent-global:garden-1:infant": 30_000,
  });
  assert.equal(settlementFamilyReservedSlots(duplicated, "faction-a"), 2);
  assert.equal(settlementFamilyReservedSlots(duplicated, "faction-b"), 0);
});

test("retrying one follower renews only that follower lease", () => {
  const adult = "agent-global:garden-1:adult";
  const infant = "agent-global:garden-1:infant";
  const retried = upsertSettlementFamilyAdmissionReservation(
    [reservation({ expiresAtMs: 20_000 })],
    reservation({ agentIds: [adult], expiresAtMs: 30_000 }),
  );
  assert.deepEqual(retried[0].agentExpiresAtMs, {
    [adult]: 30_000,
    [infant]: 20_000,
  });
  assert.equal(retried[0].expiresAtMs, 30_000);
});

test("normalization expires stale followers independently within one family reservation", () => {
  const adult = "agent-global:garden-1:adult";
  const infant = "agent-global:garden-1:infant";
  const normalized = normalizeSettlementFamilyAdmissionReservations(
    [reservation({
      expiresAtMs: 20_000,
      agentExpiresAtMs: {
        [adult]: 9_000,
        [infant]: 20_000,
      },
    })],
    new Set(),
    10_000,
  );
  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.reservations, [reservation({
    agentIds: [infant],
    expiresAtMs: 20_000,
    agentExpiresAtMs: { [infant]: 20_000 },
  })]);
});
