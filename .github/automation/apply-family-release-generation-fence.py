from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return source.replace(old, new, 1)


reservation_path = Path("src/settlement-family-reservation.ts")
text = reservation_path.read_text()
text = replace_once(
    text,
    """export function releaseSettlementFamilyAdmissionAgent(\n  reservations: readonly SettlementFamilyAdmissionReservation[],\n  agentId: string,\n  expiresAtCutoffMs: number,\n): SettlementFamilyAdmissionReservation[] {\n""",
    """export function releaseSettlementFamilyAdmissionAgent(\n  reservations: readonly SettlementFamilyAdmissionReservation[],\n  agentId: string,\n  expiresAtCutoffMs: number,\n  releaseIssuedAtMs?: number,\n): SettlementFamilyAdmissionReservation[] {\n""",
    "release signature",
)
text = replace_once(
    text,
    """  if (agentId.length === 0 || !Number.isFinite(expiresAtCutoffMs)) return [...reservations];\n  return reservations.flatMap((reservation) => {\n    if (\n      !reservation.agentIds.includes(agentId)\n      || settlementFamilyAgentLeaseExpiry(reservation, agentId) >= expiresAtCutoffMs\n    ) return [reservation];\n    const trimmed = removeSettlementFamilyReservationAgents(\n""",
    """  if (agentId.length === 0 || !Number.isFinite(expiresAtCutoffMs)) return [...reservations];\n  const releaseGeneration = typeof releaseIssuedAtMs === \"number\"\n    && Number.isFinite(releaseIssuedAtMs)\n    && releaseIssuedAtMs > 0\n      ? releaseIssuedAtMs\n      : undefined;\n  return reservations.flatMap((reservation) => {\n    if (!reservation.agentIds.includes(agentId)) return [reservation];\n    const reservationGeneration = settlementFamilyReservationIssuedAt(reservation);\n    if (releaseGeneration !== undefined && reservationGeneration > 0) {\n      // When both sides carry generations, compare the route attempts directly.\n      // This fixes the case where an old registration response arrives late and\n      // receives a destination-local lease that looks newer than the cancel.\n      // Equality is concurrent at Date.now() resolution and stays fail-closed.\n      if (reservationGeneration >= releaseGeneration) return [reservation];\n    } else if (settlementFamilyAgentLeaseExpiry(reservation, agentId) >= expiresAtCutoffMs) {\n      // Rolling compatibility for legacy reservations/releases without a\n      // generation keeps the existing lease-expiry fence.\n      return [reservation];\n    }\n    const trimmed = removeSettlementFamilyReservationAgents(\n""",
    "release generation ordering",
)
reservation_path.write_text(text)

autonomy_path = Path("src/autonomy-region.ts")
autonomy = autonomy_path.read_text()
autonomy = replace_once(
    autonomy,
    """    const next = releaseSettlementFamilyAdmissionAgent(\n      normalized.reservations,\n      body.agentId as string,\n      reservationExpiresAtCutoffMs,\n    );\n""",
    """    const next = releaseSettlementFamilyAdmissionAgent(\n      normalized.reservations,\n      body.agentId as string,\n      reservationExpiresAtCutoffMs,\n      body.releaseIssuedAtMs,\n    );\n""",
    "release call generation",
)
autonomy_path.write_text(autonomy)

test_path = Path("tests/settlement-family-reservation-generation.test.mjs")
tests = test_path.read_text()
tests = replace_once(
    tests,
    """  normalizeSettlementFamilyAdmissionReservations,\n  upsertSettlementFamilyAdmissionReservation,\n""",
    """  normalizeSettlementFamilyAdmissionReservations,\n  releaseSettlementFamilyAdmissionAgent,\n  upsertSettlementFamilyAdmissionReservation,\n""",
    "release test import",
)
anchor = '''test("an older same-route response cannot append a follower absent from the newer attempt", () => {'''
addition = r'''test("a newer release cancels an older generated reservation despite a late receipt lease", () => {
  const current = reservation({
    issuedAtMs: 200,
    expiresAtMs: 800,
    agentExpiresAtMs: { [follower]: 800 },
  });

  const next = releaseSettlementFamilyAdmissionAgent([current], follower, 500, 300);

  assert.deepEqual(next, []);
});

test("a stale release cannot cancel a newer generated reservation", () => {
  const current = reservation({
    issuedAtMs: 300,
    expiresAtMs: 500,
    agentExpiresAtMs: { [follower]: 500 },
  });

  const next = releaseSettlementFamilyAdmissionAgent([current], follower, 900, 200);

  assert.deepEqual(next, [current]);
});

test("same-millisecond registration and release keep the reservation fail-closed", () => {
  const current = reservation({
    issuedAtMs: 300,
    expiresAtMs: 500,
    agentExpiresAtMs: { [follower]: 500 },
  });

  const next = releaseSettlementFamilyAdmissionAgent([current], follower, 900, 300);

  assert.deepEqual(next, [current]);
});

'''
if tests.count(anchor) != 1:
    raise SystemExit(f"release test anchor: expected one match, found {tests.count(anchor)}")
tests = tests.replace(anchor, addition + anchor, 1)

tests = replace_once(
    tests,
    """  assert.match(\n    source,\n    /issuedAtMs,[\\s\\S]*?expiresAtMs: now \\+ SETTLEMENT_FAMILY_ADMISSION_RESERVATION_TTL_MS/,\n  );\n});\n""",
    """  assert.match(\n    source,\n    /issuedAtMs,[\\s\\S]*?expiresAtMs: now \\+ SETTLEMENT_FAMILY_ADMISSION_RESERVATION_TTL_MS/,\n  );\n  assert.match(\n    source,\n    /releaseSettlementFamilyAdmissionAgent\\([\\s\\S]*?reservationExpiresAtCutoffMs,[\\s\\S]*?body\\.releaseIssuedAtMs,[\\s\\S]*?\\);/,\n  );\n});\n""",
    "release source contract",
)
test_path.write_text(tests)
