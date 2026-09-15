from pathlib import Path
from textwrap import dedent, indent


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label} anchor not found")
    return text.replace(old, new, 1)


source_path = Path("src/autonomy-region.ts")
source = source_path.read_text()

source = replace_once(
    source,
    "  expiresAtTick: number;\n  returnToSourceStorage?: boolean;",
    "  expiresAtTick: number;\n"
    "  // Optional during rolling deploys. New return reservations retain the\n"
    "  // source faction so storage headroom remains reserved after the BOT has\n"
    "  // already handed off and is no longer present in the source WorldState.\n"
    "  sourceFactionId?: string;\n"
    "  returnToSourceStorage?: boolean;",
    "AutonomousSupplyClaim fields",
)

source = replace_once(
    source,
    '    && typeof value.expiresAtTick === "number"\n'
    '    && Number.isInteger(value.expiresAtTick)\n'
    '    && (value.returnToSourceStorage === undefined || typeof value.returnToSourceStorage === "boolean");',
    '    && typeof value.expiresAtTick === "number"\n'
    '    && Number.isInteger(value.expiresAtTick)\n'
    '    && (value.sourceFactionId === undefined || typeof value.sourceFactionId === "string")\n'
    '    && (value.returnToSourceStorage === undefined || typeof value.returnToSourceStorage === "boolean");',
    "claim validator",
)

helper_anchor = dedent('''\
function hasAvailableFactionStorage(state: WorldState, factionId: string): boolean {
  return factionStorageCapacityLeft(state, factionId) > 0;
}
''')
helper = dedent('''\

function reservedReturnStorageForFaction(
  state: WorldState,
  claims: readonly AutonomousSupplyClaim[],
  factionId: string,
): number {
  return claims.reduce((reserved, claim) => {
    if (claim.returnToSourceStorage !== true || claim.expiresAtTick <= state.tick) return reserved;
    if (claim.sourceFactionId !== undefined) {
      return claim.sourceFactionId === factionId ? reserved + claim.amount : reserved;
    }
    const localAgent = claim.agentId === undefined
      ? undefined
      : state.agents.find((entry) => entry.id === claim.agentId);
    if (localAgent !== undefined) {
      return localAgent.factionId === factionId ? reserved + claim.amount : reserved;
    }
    // Rolling-deploy compatibility: an older in-flight return claim can
    // outlive its source-side BOT. Without a persisted faction we cannot prove
    // it belongs elsewhere, so reserve its amount conservatively for every
    // faction until the short claim TTL expires instead of overbooking.
    return reserved + claim.amount;
  }, 0);
}
''')
source = replace_once(source, helper_anchor, helper_anchor + helper, "storage helper")

old_claim = indent(dedent('''\
const claimId = `autonomy-claim:${state.regionId}:${plan.agentId}:${state.tick}:${plan.direction}:${plan.neighborRegionId}`;
const pendingPlan: PendingAutonomousTravel = { ...plan, claimId };
const claimedSupply = plan.claimedSupply ?? 0;
if (claimedSupply > 0) {
  workingClaims.push({
    claimId,
    agentId: plan.agentId,
    resource: plan.resource,
    direction: plan.direction,
    neighborRegionId: plan.neighborRegionId,
    amount: claimedSupply,
    expiresAtTick: state.tick + AUTONOMOUS_SUPPLY_CLAIM_TTL,
    // Only promise a return-to-source deposit when that source currently
    // has real storage headroom. An active but full structure must not
    // masquerade as usable logistics capacity.
    returnToSourceStorage: hasAvailableFactionStorage(state, agent.factionId),
  });
}
'''), "      ")
new_claim = indent(dedent('''\
const claimId = `autonomy-claim:${state.regionId}:${plan.agentId}:${state.tick}:${plan.direction}:${plan.neighborRegionId}`;
const plannedSupply = plan.claimedSupply ?? 0;
const sourceStorageHeadroom = factionStorageCapacityLeft(state, agent.factionId);
const reservedReturnStorage = reservedReturnStorageForFaction(
  state,
  workingClaims,
  agent.factionId,
);
const availableReturnStorage = Math.max(0, sourceStorageHeadroom - reservedReturnStorage);
const returnToSourceStorage = availableReturnStorage > 0;
// A return reservation is a capacity promise, not just a boolean hint. Bound
// the supply claim by still-unreserved source storage so concurrent scouts do
// not all plan to deposit into the same final slots.
const claimedSupply = returnToSourceStorage
  ? Math.min(plannedSupply, availableReturnStorage)
  : plannedSupply;
const pendingPlan: PendingAutonomousTravel = {
  ...plan,
  claimId,
  claimedSupply,
};
if (claimedSupply > 0) {
  workingClaims.push({
    claimId,
    agentId: plan.agentId,
    resource: plan.resource,
    direction: plan.direction,
    neighborRegionId: plan.neighborRegionId,
    amount: claimedSupply,
    expiresAtTick: state.tick + AUTONOMOUS_SUPPLY_CLAIM_TTL,
    sourceFactionId: agent.factionId,
    returnToSourceStorage,
  });
}
'''), "      ")
source = replace_once(source, old_claim, new_claim, "claim creation")
source_path.write_text(source)

test_path = Path("tests/autonomous-concurrent-travel-do.test.mjs")
test_text = test_path.read_text()
import_anchor = 'import { WorldRuntime } from "../dist-ts/src/runtime.js";'
test_text = replace_once(
    test_text,
    import_anchor,
    import_anchor + '\nimport { BUILD_RECIPES } from "../dist-ts/src/protocol.js";',
    "test import",
)

addition = dedent(r'''

test("concurrent return expeditions reserve source storage headroom instead of overbooking it", async () => {
  const { source } = await expeditionFixture(8);
  const state = source.object.runtime.snapshot();
  const scout = state.agents.find((agent) => agent.autonomy);
  assert.ok(scout);

  for (const structure of state.structures) {
    if (structure.factionId !== scout.factionId || structure.status !== "active") continue;
    structure.storage = {
      wood: BUILD_RECIPES[structure.type].storageCapacity,
      stone: 0,
      food: 0,
    };
  }
  state.structures.push({
    id: "three-slot-return-storehouse",
    factionId: scout.factionId,
    type: "storehouse",
    position: hexGridCenter(state),
    status: "active",
    progress: 1,
    requiredProgress: 1,
    storage: { wood: BUILD_RECIPES.storehouse.storageCapacity - 3, stone: 0, food: 0 },
  });
  source.object.runtime = new WorldRuntime({ state });
  await source.object.persist();

  await source.object.alarm();
  const claims = await source.state.storage.get(CLAIMS_KEY);
  assert.equal(claims.length, 3);
  const returnClaims = claims.filter((claim) => claim.returnToSourceStorage === true);
  assert.equal(returnClaims.reduce((sum, claim) => sum + claim.amount, 0), 3);
  assert.deepEqual(returnClaims.map((claim) => claim.amount).sort((a, b) => a - b), [1, 2]);
  assert.equal(claims.filter((claim) => claim.returnToSourceStorage !== true).length, 1);
  assert.ok(claims.every((claim) => claim.sourceFactionId === scout.factionId));
});
''').strip()
if "concurrent return expeditions reserve source storage headroom" in test_text:
    raise SystemExit("regression test already exists")
test_path.write_text(test_text.rstrip() + "\n\n" + addition + "\n")
