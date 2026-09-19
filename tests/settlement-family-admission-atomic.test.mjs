import assert from "node:assert/strict";
import test from "node:test";
import { globalHandoffAgentId } from "../dist-ts/src/agent-ownership.js";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import {
  registerSettlementFamilyFollowers,
  settlementFamilyRegistrationDeferred,
} from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function clearHex(state) {
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
  }
}

test("family migration keeps a dependent with its active source-side caregiver", () => {
  const source = createInitialWorld({
    seed: 260925,
    width: 40,
    height: 24,
    regionId: "garden-1",
  });
  clearHex(source);
  const template = structuredClone(source.agents[0]);
  assert.ok(template);
  const pioneerId = globalHandoffAgentId("pioneer", source.regionId);
  const partner = {
    ...structuredClone(template),
    id: "partner",
    factionId: template.factionId,
    hp: 100,
    position: { x: 20, y: 11 },
  };
  const child = {
    ...structuredClone(template),
    id: "child",
    factionId: template.factionId,
    hp: 100,
    autonomy: false,
    lifeStage: "infant",
    parents: [pioneerId, partner.id],
    position: { x: 20, y: 11 },
  };
  source.agents = [partner, child];

  const oneSlot = registerSettlementFamilyFollowers(
    source,
    pioneerId,
    "hex-q1-r0",
    template.factionId,
    globalHandoffAgentId(partner.id, source.regionId),
    1,
  );
  assert.deepEqual(
    oneSlot.agentIds,
    [],
    "a single admission slot must not migrate the caregiver while stranding the dependent",
  );
  assert.equal(partner.settlementFamilyTargetRegionId, undefined);
  assert.equal(child.settlementFamilyTargetRegionId, undefined);
  assert.equal(oneSlot.candidateCount, 2);
  assert.equal(settlementFamilyRegistrationDeferred(oneSlot), true);

  const twoSlots = registerSettlementFamilyFollowers(
    source,
    pioneerId,
    "hex-q1-r0",
    template.factionId,
    globalHandoffAgentId(partner.id, source.regionId),
    2,
  );
  assert.deepEqual(twoSlots.agentIds, ["partner", "child"]);
  assert.equal(partner.settlementFamilyTargetRegionId, "hex-q1-r0");
  assert.equal(child.settlementFamilyTargetRegionId, "hex-q1-r0");
  assert.equal(settlementFamilyRegistrationDeferred(twoSlots), false);
});
