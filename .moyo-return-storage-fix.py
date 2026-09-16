from pathlib import Path

source_path = Path("src/autonomy-region.ts")
source = source_path.read_text()

def replace_once(old: str, new: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"expected one source match, got {count}: {old[:120]!r}")
    source = source.replace(old, new, 1)

replace_once(
    "  returnStorageAmount?: number;\n  // Source-local reservation against a concrete remote storage observation.\n",
    "  returnStorageAmount?: number;\n"
    "  // Crash-safe wall-clock lease for source storage promised to cargo in transit.\n"
    "  // Optional so existing persisted claims remain compatible during rolling deploys.\n"
    "  returnStorageLeaseExpiresAtMs?: number;\n"
    "  // Source-local reservation against a concrete remote storage observation.\n",
)
replace_once(
    "const DESTINATION_STORAGE_RESERVATION_TTL_MS = 15 * 60 * 1_000;\n"
    "const SETTLEMENT_MIGRATION_TTL = 72;\n",
    "const DESTINATION_STORAGE_RESERVATION_TTL_MS = 15 * 60 * 1_000;\n"
    "// Source simulation ticks can advance much faster than a courier in warm/cold\n"
    "// relay regions. Keep the promised return sink alive on wall time as well, but\n"
    "// bound crash leakage so abandoned cargo cannot reserve capacity forever.\n"
    "const RETURN_STORAGE_RESERVATION_TTL_MS = 6 * 60 * 60 * 1_000;\n"
    "const SETTLEMENT_MIGRATION_TTL = 72;\n",
)
replace_once(
    '    && (value.returnStorageAmount === undefined || (\n'
    '      typeof value.returnStorageAmount === "number"\n'
    '      && Number.isFinite(value.returnStorageAmount)\n'
    '      && value.returnStorageAmount >= 0\n'
    '    ))\n'
    '    && (value.destinationStorageReserved === undefined || typeof value.destinationStorageReserved === "boolean");\n',
    '    && (value.returnStorageAmount === undefined || (\n'
    '      typeof value.returnStorageAmount === "number"\n'
    '      && Number.isFinite(value.returnStorageAmount)\n'
    '      && value.returnStorageAmount >= 0\n'
    '    ))\n'
    '    && (value.returnStorageLeaseExpiresAtMs === undefined || (\n'
    '      typeof value.returnStorageLeaseExpiresAtMs === "number"\n'
    '      && Number.isFinite(value.returnStorageLeaseExpiresAtMs)\n'
    '      && value.returnStorageLeaseExpiresAtMs > 0\n'
    '    ))\n'
    '    && (value.destinationStorageReserved === undefined || typeof value.destinationStorageReserved === "boolean");\n',
)
replace_once(
    "function reservedReturnStorageForFaction(\n"
    "  state: WorldState,\n"
    "  claims: readonly AutonomousSupplyClaim[],\n"
    "  factionId: string,\n"
    "): number {\n"
    "  return claims.reduce((reserved, claim) => {\n"
    "    if (claim.returnToSourceStorage !== true || claim.expiresAtTick <= state.tick) return reserved;\n",
    "function returnStorageReservationActive(\n"
    "  stateTick: number,\n"
    "  claim: AutonomousSupplyClaim,\n"
    "  now = Date.now(),\n"
    "): boolean {\n"
    "  if (claim.returnToSourceStorage !== true) return false;\n"
    "  const reservedAmount = claim.returnStorageAmount ?? claim.amount;\n"
    "  if (reservedAmount <= 0) return false;\n"
    "  return claim.expiresAtTick > stateTick\n"
    "    || (claim.returnStorageLeaseExpiresAtMs ?? 0) > now;\n"
    "}\n\n"
    "function reservedReturnStorageForFaction(\n"
    "  state: WorldState,\n"
    "  claims: readonly AutonomousSupplyClaim[],\n"
    "  factionId: string,\n"
    "): number {\n"
    "  const now = Date.now();\n"
    "  return claims.reduce((reserved, claim) => {\n"
    "    if (!returnStorageReservationActive(state.tick, claim, now)) return reserved;\n",
)
replace_once(
    "    const active = valid.filter((claim) => claim.expiresAtTick > tick);\n"
    "    if (!Array.isArray(stored) || active.length !== stored.length) {\n"
    "      await this.autonomyState.storage.put(AUTONOMOUS_SUPPLY_CLAIMS_KEY, active);\n"
    "    }\n"
    "    return active;\n",
    "    const now = Date.now();\n"
    "    let upgraded = false;\n"
    "    const normalized = valid.map((claim) => {\n"
    "      const reservedAmount = claim.returnStorageAmount ?? claim.amount;\n"
    "      if (\n"
    "        claim.returnToSourceStorage === true\n"
    "        && reservedAmount > 0\n"
    "        && claim.returnStorageLeaseExpiresAtMs === undefined\n"
    "        && claim.expiresAtTick > tick\n"
    "      ) {\n"
    "        upgraded = true;\n"
    "        return {\n"
    "          ...claim,\n"
    "          returnStorageLeaseExpiresAtMs: now + RETURN_STORAGE_RESERVATION_TTL_MS,\n"
    "        };\n"
    "      }\n"
    "      return claim;\n"
    "    });\n"
    "    const active = normalized.filter((claim) =>\n"
    "      claim.expiresAtTick > tick || returnStorageReservationActive(tick, claim, now)\n"
    "    );\n"
    "    if (!Array.isArray(stored) || active.length !== stored.length || upgraded) {\n"
    "      await this.autonomyState.storage.put(AUTONOMOUS_SUPPLY_CLAIMS_KEY, active);\n"
    "    }\n"
    "    return active;\n",
)
replace_once(
    "                  returnStorageAmount: claim.returnStorageAmount ?? claim.amount,\n"
    "                  expiresAtTick: Math.max(claim.expiresAtTick, tick + AUTONOMOUS_SUPPLY_CLAIM_TTL),\n",
    "                  returnStorageAmount: claim.returnStorageAmount ?? claim.amount,\n"
    "                  returnStorageLeaseExpiresAtMs: Date.now() + RETURN_STORAGE_RESERVATION_TTL_MS,\n"
    "                  expiresAtTick: Math.max(claim.expiresAtTick, tick + AUTONOMOUS_SUPPLY_CLAIM_TTL),\n",
)
replace_once(
    "          ...(returnToSourceStorage ? { returnStorageAmount: claimedSupply } : {}),\n"
    "          ...(destinationStorageReserved ? { destinationStorageReserved: true } : {}),\n",
    "          ...(returnToSourceStorage\n"
    "            ? {\n"
    "                returnStorageAmount: claimedSupply,\n"
    "                returnStorageLeaseExpiresAtMs: Date.now() + RETURN_STORAGE_RESERVATION_TTL_MS,\n"
    "              }\n"
    "            : {}),\n"
    "          ...(destinationStorageReserved ? { destinationStorageReserved: true } : {}),\n",
)
source_path.write_text(source)

test_path = Path("tests/autonomy-material-return-relay.test.mjs")
tests = test_path.read_text()
marker = "wall-clock return-storage lease survives source tick skew"
if marker in tests:
    raise SystemExit("regression test already exists")
tests += """
test("wall-clock return-storage lease survives source tick skew and still expires crash-safely", async () => {
  const env = environment();
  const origin = await assignRegion(env, "hex-q2-r0");
  const state = origin.object.runtime.snapshot();
  state.tick = 500;
  for (const candidate of state.agents) candidate.autonomy = false;
  const courier = state.agents[0];
  assert.ok(courier);
  origin.object.runtime = new WorldRuntime({ state });
  await origin.object.persist();

  const initialLease = Date.now() + 60_000;
  const claim = {
    claimId: "wall-clock-return",
    agentId: courier.id,
    resource: "wood",
    direction: "W",
    neighborRegionId: "garden-2",
    amount: 0,
    settledAmount: 4,
    expiresAtTick: state.tick - 1,
    sourceFactionId: courier.factionId,
    returnToSourceStorage: true,
    returnStorageAmount: 4,
    returnStorageLeaseExpiresAtMs: initialLease,
  };
  await origin.state.storage.put(SUPPLY_CLAIMS_KEY, [claim]);

  const settle = await origin.object.fetch(new Request("https://moyo.internal/api/internal/autonomy/claim/settle", {
    method: "POST",
    headers: { "content-type": "application/json", "x-moyo-region-internal": "hex-q2-r0" },
    body: JSON.stringify({ claimId: claim.claimId, settledAmount: 4 }),
  }));
  assert.equal(settle.status, 200);
  const kept = await origin.state.storage.get(SUPPLY_CLAIMS_KEY);
  const renewed = kept?.find((entry) => entry.claimId === claim.claimId);
  assert.ok(renewed, "wall-clock lease should keep promised return capacity after source tick TTL expires");
  assert.ok(renewed.expiresAtTick > state.tick, "settlement should refresh the tick fallback");
  assert.ok(renewed.returnStorageLeaseExpiresAtMs > initialLease, "settlement should refresh the bounded wall-clock lease");

  await origin.state.storage.put(SUPPLY_CLAIMS_KEY, [{
    ...claim,
    returnStorageLeaseExpiresAtMs: Date.now() - 1,
  }]);
  const expired = await origin.object.fetch(new Request("https://moyo.internal/api/internal/autonomy/claim/settle", {
    method: "POST",
    headers: { "content-type": "application/json", "x-moyo-region-internal": "hex-q2-r0" },
    body: JSON.stringify({ claimId: claim.claimId, settledAmount: 4 }),
  }));
  assert.equal(expired.status, 200);
  const afterExpiry = await origin.state.storage.get(SUPPLY_CLAIMS_KEY);
  assert.ok(
    afterExpiry === undefined || afterExpiry.every((entry) => entry.claimId !== claim.claimId),
    "expired tick and wall-clock leases should release orphaned return capacity",
  );
});
"""
test_path.write_text(tests)
