from pathlib import Path
import re


def sub_once(text: str, pattern: str, replacement: str, label: str) -> str:
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, got {count}")
    return next_text


settlement = Path("src/settlement-migration.ts")
s = settlement.read_text()
s = sub_once(
    s,
    r"(export function registerSettlementFamilyFollowers\(\n\s*state: WorldState,\n\s*pioneerId: string,\n\s*targetRegionId: string,\n\s*factionId: string,\n\s*pioneerPartnerId\?: string,\n)(\s*\): SettlementFamilyRegistrationResult \{)",
    r"\1  maxFollowers = MAX_SETTLEMENT_FAMILY_FOLLOWERS,\n\2",
    "family registration signature",
)
s = sub_once(
    s,
    r"\s{2}const selected = \[\.\.\.priorities\]\n\s+\.sort\(\(a, b\) => a\[1\] - b\[1\] \|\| a\[0\]\.localeCompare\(b\[0\]\)\)\n\s+\.slice\(0, MAX_SETTLEMENT_FAMILY_FOLLOWERS\)\n\s+\.map\(\(\[agentId\]\) => agentId\);",
    "  const followerLimit = Number.isFinite(maxFollowers)\n    ? Math.max(0, Math.min(MAX_SETTLEMENT_FAMILY_FOLLOWERS, Math.floor(maxFollowers)))\n    : MAX_SETTLEMENT_FAMILY_FOLLOWERS;\n  const selected = [...priorities]\n    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))\n    .slice(0, followerLimit)\n    .map(([agentId]) => agentId);",
    "family follower selection",
)
admission_marker = "export function settlementFamilyAdmissionReady(state: WorldState, factionId: string): boolean {"
if admission_marker not in s:
    raise SystemExit("family admission marker missing")
housing_helper = '''export function settlementFamilyHousingHeadroom(state: WorldState, factionId: string): number {
  const activeCamps = state.structures.filter((structure) =>
    structure.factionId === factionId
    && structure.status === "active"
    && structure.type === "camp"
  ).length;
  const residents = state.agents.filter((agent) =>
    agent.factionId === factionId && agent.hp > 0
  ).length;
  return Math.max(0, activeCamps * RESIDENT_CAPACITY_PER_CAMP - residents);
}

'''
s = s.replace(admission_marker, housing_helper + admission_marker, 1)
s = sub_once(
    s,
    r'(\s*if \(!activeStructures\.some\(\(structure\) => structure\.type === "camp"\)\) return false;\n)',
    r"\1  if (settlementFamilyHousingHeadroom(state, factionId) <= 0) return false;\n",
    "family admission housing gate",
)
settlement.write_text(s)

autonomy = Path("src/autonomy-region.ts")
a = autonomy.read_text()
a = sub_once(
    a,
    r"(\s+registerSettlementFamilyFollowers,\n\s+settlementFamilyAdmissionReady,\n)",
    r"\1  settlementFamilyHousingHeadroom,\n",
    "settlement import block",
)
a = sub_once(
    a,
    r'(\s+\|\| \(body\.pioneerPartnerId !== undefined && typeof body\.pioneerPartnerId !== "string"\)\n)(\s+\|\| regionAxialCoordinate\(body\.targetRegionId\) === undefined)',
    r"\1      || (body.maxFollowers !== undefined && (!Number.isInteger(body.maxFollowers) || body.maxFollowers < 0))\n\2",
    "family registration validation",
)
a = sub_once(
    a,
    r"(\s+body\.factionId,\n\s+body\.pioneerPartnerId,\n)(\s+\);)",
    r"\1      body.maxFollowers,\n\2",
    "family registration call",
)
a = sub_once(
    a,
    r'(\s+)if \(!settlementFamilyAdmissionReady\(state, pioneer\.factionId\)\) continue;\n(\s+)try \{',
    r"\1const familyHousingHeadroom = settlementFamilyHousingHeadroom(state, pioneer.factionId);\n\1if (familyHousingHeadroom <= 0 || !settlementFamilyAdmissionReady(state, pioneer.factionId)) continue;\n\2try {",
    "pioneer admission gate",
)
a = sub_once(
    a,
    r'(\s+factionId: pioneer\.factionId,\n)(\s+\.\.\.\(pioneer\.pregnancy\?\.partnerId === undefined)',
    r"\1              maxFollowers: familyHousingHeadroom,\n\2",
    "family registration payload",
)
autonomy.write_text(a)

tests = Path("tests/settlement-family-follow.test.mjs")
t = tests.read_text()
t = sub_once(
    t,
    r"(\s+registerSettlementFamilyFollowers,\n\s+settlementFamilyAdmissionReady,\n)(\s+\} from \"\.\./dist-ts/src/settlement-migration\.js\";)",
    r"\1  settlementFamilyHousingHeadroom,\n\2",
    "test import block",
)
if "family admission uses camp resident headroom" in t:
    raise SystemExit("test already present")
test_case = '''

test("family admission uses camp resident headroom and follower registration respects it", () => {
  const destination = createInitialWorld({ seed: 260922, width: 40, height: 24, regionId: "hex-q1-r0" });
  clearHex(destination);
  const faction = destination.factions[0];
  assert.ok(faction);
  const residentTemplate = baseAgent(destination);
  destination.structures = [{
    id: "frontier-camp",
    factionId: faction.id,
    type: "camp",
    position: { x: 19, y: 11 },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  }];
  faction.resources = { wood: 0, stone: 0, food: 2 };
  destination.agents = Array.from({ length: 5 }, (_, index) => ({
    ...structuredClone(residentTemplate),
    id: `resident-${index}`,
    factionId: faction.id,
    hp: 100,
  }));
  assert.equal(settlementFamilyHousingHeadroom(destination, faction.id), 1);
  assert.equal(settlementFamilyAdmissionReady(destination, faction.id), true);
  destination.agents.push({
    ...structuredClone(residentTemplate),
    id: "resident-full",
    factionId: faction.id,
    hp: 100,
  });
  assert.equal(settlementFamilyHousingHeadroom(destination, faction.id), 0);
  assert.equal(settlementFamilyAdmissionReady(destination, faction.id), false);

  const source = createInitialWorld({ seed: 260923, width: 40, height: 24, regionId: "garden-1" });
  clearHex(source);
  const template = baseAgent(source);
  const pioneerId = globalHandoffAgentId("pioneer", source.regionId);
  const partner = { ...structuredClone(template), id: "partner", factionId: template.factionId, hp: 100 };
  const child = {
    ...structuredClone(template),
    id: "child",
    factionId: template.factionId,
    hp: 100,
    autonomy: false,
    lifeStage: "infant",
    parents: [pioneerId, partner.id],
  };
  source.agents = [partner, child];
  const limited = registerSettlementFamilyFollowers(
    source,
    pioneerId,
    "hex-q1-r0",
    template.factionId,
    globalHandoffAgentId(partner.id, source.regionId),
    1,
  );
  assert.deepEqual(limited.agentIds, ["partner"]);
  assert.equal(partner.settlementFamilyTargetRegionId, "hex-q1-r0");
  assert.equal(child.settlementFamilyTargetRegionId, undefined);
});
'''
tests.write_text(t + test_case)
