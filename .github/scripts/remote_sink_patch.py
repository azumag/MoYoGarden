from pathlib import Path

path = Path("src/autonomy-region.ts")
text = path.read_text()

def replace_one(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, got {count}")
    text = text.replace(old, new, 1)

replace_one(
    "  settledAmount?: number;\n  returnToSourceStorage?: boolean;\n}\n\ninterface AutonomousDestinationStorageReservation",
    "  settledAmount?: number;\n  returnToSourceStorage?: boolean;\n  // Destination-local admitted capacity; optional for rolling compatibility.\n  destinationStorageReserved?: boolean;\n}\n\ninterface AutonomousDestinationStorageReservation",
    "arrival claim interface",
)

start = text.index("function isAutonomousArrivalClaim")
end = text.index("function isDestinationStorageReservation", start)
part = text[start:end]
old = '    && (value.returnToSourceStorage === undefined || typeof value.returnToSourceStorage === "boolean");'
new = '    && (value.returnToSourceStorage === undefined || typeof value.returnToSourceStorage === "boolean")\n    && (value.destinationStorageReserved === undefined || typeof value.destinationStorageReserved === "boolean");'
if part.count(old) != 1:
    raise SystemExit("arrival claim validator marker missing")
text = text[:start] + part.replace(old, new, 1) + text[end:]

start = text.index("  private async releaseDestinationStorage(request: Request): Promise<Response> {")
end = text.index("  private async registerSettlementFamilyFollow", start)
release = "\n".join([
    "  private async releaseDestinationStorageReservation(",
    "    claimId: string,",
    "    sourceRegionId: string,",
    "  ): Promise<void> {",
    "    const now = Date.now();",
    "    await this.autonomyState.blockConcurrencyWhile(async () => {",
    "      const stored = await this.autonomyState.storage.get<unknown>(AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY);",
    "      const reservations = Array.isArray(stored)",
    "        ? stored",
    "          .filter(isDestinationStorageReservation)",
    "          .filter((entry) => entry.expiresAtMs > now)",
    "        : [];",
    "      const next = reservations.filter((entry) =>",
    "        entry.claimId !== claimId || entry.sourceRegionId !== sourceRegionId",
    "      );",
    "      if (!Array.isArray(stored) || next.length !== stored.length) {",
    "        await this.autonomyState.storage.put(AUTONOMOUS_DESTINATION_STORAGE_RESERVATIONS_KEY, next);",
    "      }",
    "    });",
    "  }",
    "",
    "  private async releaseDestinationStorage(request: Request): Promise<Response> {",
    "    let body: unknown;",
    "    try {",
    "      body = await request.json();",
    "    } catch {",
    "      return new Response(JSON.stringify({ error: \"request body must be valid JSON\" }), { status: 400 });",
    "    }",
    "    if (",
    "      !isRecord(body)",
    "      || typeof body.claimId !== \"string\"",
    "      || body.claimId.trim() === \"\"",
    "      || typeof body.sourceRegionId !== \"string\"",
    "      || !isAutonomyClaimSourceRegionId(configuredRegionIds(this.autonomyEnv), body.sourceRegionId)",
    "    ) {",
    "      return new Response(JSON.stringify({ error: \"claimId and sourceRegionId are required\" }), {",
    "        status: 400,",
    "      });",
    "    }",
    "    await this.releaseDestinationStorageReservation(body.claimId, body.sourceRegionId);",
    "    return new Response(JSON.stringify({ ok: true, claimId: body.claimId }), {",
    "      headers: { \"content-type\": \"application/json; charset=utf-8\" },",
    "    });",
    "  }",
    "",
])
text = text[:start] + release + text[end:]

start = text.index("  private async registerArrivalClaim")
end = text.index("  private async settleArrivalSourceClaim", start)
part = text[start:end]
marker = "    const claims = await this.arrivalClaims();\n"
inserted = (
    "    const destinationReservations = await this.activeDestinationStorageReservations();\n"
    "    const destinationStorageReserved = destinationReservations.some((entry) =>\n"
    "      entry.claimId === body.claimId && entry.sourceRegionId === body.sourceRegionId\n"
    "    );\n"
    "    const claims = await this.arrivalClaims();\n"
)
if part.count(marker) != 1:
    raise SystemExit("arrival claims load marker missing")
part = part.replace(marker, inserted, 1)
marker = "      returnToSourceStorage: existing?.returnToSourceStorage ?? body.returnToSourceStorage === true,\n"
if part.count(marker) != 1:
    raise SystemExit("arrival claim object marker missing")
part = part.replace(marker, marker + "      destinationStorageReserved: existing?.destinationStorageReserved ?? destinationStorageReserved,\n", 1)
text = text[:start] + part + text[end:]

start = text.index("  private async reconcileArrivalClaims")
end = text.index("  private replaceRuntimeState", start)
part = text[start:end]
old = (
    "      if (reservationExhausted) {\n"
    "        dirty = true;\n"
    "        continue;\n"
    "      }\n"
    "      if (stillGathering) {\n"
    "        keep.push(updatedClaim);\n"
    "        continue;\n"
    "      }\n\n"
    "      try {"
)
new = (
    "      if (stillGathering) {\n"
    "        keep.push(updatedClaim);\n"
    "        continue;\n"
    "      }\n\n"
    "      // Keep admitted sink capacity until gathered cargo leaves this BOT.\n"
    "      // Releasing at gather completion can overbook storage before deposit commits.\n"
    "      const destinationCargoOutstanding =\n"
    "        updatedClaim.destinationStorageReserved === true\n"
    "        && gatheredAmount > 0\n"
    "        && agent !== undefined\n"
    "        && agent.inventory[updatedClaim.resource] > 0;\n"
    "      if (destinationCargoOutstanding) {\n"
    "        keep.push(updatedClaim);\n"
    "        continue;\n"
    "      }\n"
    "      if (updatedClaim.destinationStorageReserved === true) {\n"
    "        await this.releaseDestinationStorageReservation(\n"
    "          updatedClaim.claimId,\n"
    "          updatedClaim.sourceRegionId,\n"
    "        );\n"
    "        dirty = true;\n"
    "      }\n\n"
    "      if (reservationExhausted) {\n"
    "        dirty = true;\n"
    "        continue;\n"
    "      }\n\n"
    "      try {"
)
if part.count(old) != 1:
    raise SystemExit("reconcile reservation marker missing")
text = text[:start] + part.replace(old, new, 1) + text[end:]
path.write_text(text)

test_path = Path("tests/autonomous-concurrent-travel-do.test.mjs")
tests = test_path.read_text()
name = "remote sink reservation remains until gathered cargo leaves the arriving inventory"
if name in tests:
    raise SystemExit("regression test already exists")
lines = [
    "",
    'test("remote sink reservation remains until gathered cargo leaves the arriving inventory", async () => {',
    '  const env = environment();',
    '  await assignRegion(env, "garden-1");',
    '  const destination = await assignRegion(env, "garden-2");',
    '  let state = destination.object.runtime.snapshot();',
    '  const agent = state.agents[0];',
    '  assert.ok(agent);',
    '  agent.autonomy = true;',
    '  agent.role = "woodcutter";',
    '  agent.capacity = 10;',
    '  agent.energy = 100;',
    '  agent.inventory = { wood: 0, stone: 0, food: 0 };',
    '  agent.task = { source: "autonomy", issuedAtTick: state.tick, type: "gather", resource: "wood" };',
    '  const factionId = agent.factionId;',
    '  for (const structure of state.structures) {',
    '    if (structure.factionId !== factionId || structure.status !== "active") continue;',
    '    structure.storage = { wood: BUILD_RECIPES[structure.type].storageCapacity, stone: 0, food: 0 };',
    '  }',
    '  state.structures.push({',
    '    id: "reserved-arrival-storehouse", factionId, type: "storehouse",',
    '    position: hexGridCenter(state), status: "active", progress: 1, requiredProgress: 1,',
    '    storage: { wood: BUILD_RECIPES.storehouse.storageCapacity - 2, stone: 0, food: 0 },',
    '  });',
    '  destination.object.runtime = new WorldRuntime({ state });',
    '  await destination.object.persist();',
    '',
    '  const reservationResponse = await destination.object.fetch(new Request(',
    '    "https://moyo.internal/api/internal/autonomy/storage/reserve", {',
    '      method: "POST",',
    '      headers: { "content-type": "application/json", "x-moyo-region-internal": "garden-2" },',
    '      body: JSON.stringify({ claimId: "remote-sink-cargo", sourceRegionId: "garden-1", factionId, amount: 2 }),',
    '    },',
    '  ));',
    '  assert.equal(reservationResponse.status, 200);',
    '  assert.equal((await reservationResponse.json()).grantedAmount, 2);',
    '',
    '  const arrivalResponse = await destination.object.fetch(new Request(',
    '    "https://moyo.internal/api/internal/autonomy/claim/register", {',
    '      method: "POST",',
    '      headers: { "content-type": "application/json", "x-moyo-region-internal": "garden-2" },',
    '      body: JSON.stringify({ claimId: "remote-sink-cargo", sourceRegionId: "garden-1", agentId: agent.id, resource: "wood" }),',
    '    },',
    '  ));',
    '  assert.equal(arrivalResponse.status, 200);',
    '  const registered = await destination.state.storage.get(ARRIVAL_CLAIMS_KEY);',
    '  assert.equal(registered[0].destinationStorageReserved, true);',
    '  registered[0].gatheredAmount = 2;',
    '  registered[0].settledAmount = 2;',
    '  await destination.state.storage.put(ARRIVAL_CLAIMS_KEY, registered);',
    '',
    '  state = destination.object.runtime.snapshot();',
    '  const carrying = state.agents.find((entry) => entry.id === agent.id);',
    '  assert.ok(carrying);',
    '  carrying.autonomy = false;',
    '  carrying.inventory.wood = 2;',
    '  delete carrying.task;',
    '  for (const structure of state.structures) {',
    '    if (structure.factionId !== factionId || structure.status !== "active") continue;',
    '    structure.storage = { wood: BUILD_RECIPES[structure.type].storageCapacity, stone: 0, food: 0 };',
    '  }',
    '  destination.object.runtime = new WorldRuntime({ state });',
    '  await destination.object.persist();',
    '',
    '  await destination.object.alarm();',
    '  assert.equal((await destination.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY)).length, 1);',
    '  assert.equal((await destination.state.storage.get(ARRIVAL_CLAIMS_KEY)).length, 1);',
    '',
    '  state = destination.object.runtime.snapshot();',
    '  const delivered = state.agents.find((entry) => entry.id === agent.id);',
    '  assert.ok(delivered);',
    '  delivered.inventory.wood = 0;',
    '  destination.object.runtime = new WorldRuntime({ state });',
    '  await destination.object.persist();',
    '',
    '  await destination.object.alarm();',
    '  assert.deepEqual(await destination.state.storage.get(DESTINATION_STORAGE_RESERVATIONS_KEY), []);',
    '  assert.deepEqual(await destination.state.storage.get(ARRIVAL_CLAIMS_KEY), []);',
    '});',
    '',
]
test_path.write_text(tests + "\n".join(lines))
