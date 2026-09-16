import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function frontierHalo() {
  return [{
    direction: "E",
    sourcePosition: { x: 30, y: 11 },
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: {
      x: 8,
      y: 11,
      terrain: "plain",
      elevation: 0.5,
      resource: { kind: "food", amount: 8, maxAmount: 20 },
    },
  }];
}

function migrationBuilder(template, id, energy) {
  const builder = structuredClone(template);
  builder.id = id;
  builder.autonomy = true;
  builder.energy = energy;
  builder.position = { x: 19, y: 11 };
  builder.inventory = {
    wood: BUILD_RECIPES.camp.cost.wood,
    stone: BUILD_RECIPES.camp.cost.stone,
    food: BUILD_RECIPES.camp.cost.food,
  };
  builder.task = {
    source: "autonomy",
    issuedAtTick: 25,
    type: "build",
    structureType: "camp",
  };
  delete builder.parents;
  delete builder.pregnancy;
  return builder;
}

function migrationWorld() {
  const state = createInitialWorld({ seed: 260916, width: 40, height: 24 });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
  }
  state.structures = [];
  state.tick = 25;
  return state;
}

test("equivalent settlement routes prefer a pioneer who leaves fewer dependents", () => {
  const state = migrationWorld();
  const template = state.agents.find((agent) => agent.role === "builder");
  assert.ok(template);
  const attached = migrationBuilder(template, "agent-a-attached", 95);
  const unattached = migrationBuilder(template, "agent-z-unattached", 70);
  const infant = structuredClone(template);
  infant.id = "agent-child";
  infant.autonomy = false;
  infant.lifeStage = "infant";
  infant.birthTick = 1;
  infant.energy = 60;
  infant.position = { x: 19, y: 10 };
  infant.parents = [attached.id, "agent-other-parent"];
  delete infant.task;
  delete infant.pregnancy;
  state.agents = [attached, unattached, infant];

  const plan = planAutonomousSettlementMigration(state, frontierHalo());
  assert.ok(plan);
  assert.equal(plan.agentId, unattached.id);
});

test("family attachment remains a soft preference when no other pioneer can migrate", () => {
  const state = migrationWorld();
  const template = state.agents.find((agent) => agent.role === "builder");
  assert.ok(template);
  const attached = migrationBuilder(template, "agent-attached-only", 80);
  const infant = structuredClone(template);
  infant.id = "agent-only-child";
  infant.autonomy = false;
  infant.lifeStage = "infant";
  infant.birthTick = 1;
  infant.position = { x: 19, y: 10 };
  infant.parents = [attached.id, "agent-other-parent"];
  delete infant.task;
  delete infant.pregnancy;
  state.agents = [attached, infant];

  const plan = planAutonomousSettlementMigration(state, frontierHalo());
  assert.ok(plan);
  assert.equal(plan.agentId, attached.id);
});


test("pregnancy does not count as separation when the partner is absent from the region", () => {
  const state = migrationWorld();
  const template = state.agents.find((agent) => agent.role === "builder");
  assert.ok(template);
  const pregnant = migrationBuilder(template, "agent-a-pregnant", 95);
  pregnant.pregnancy = {
    partnerId: "agent-partner-already-away",
    conceivedAtTick: 10,
    dueAtTick: 100,
  };
  const unattached = migrationBuilder(template, "agent-z-unattached", 70);
  state.agents = [pregnant, unattached];

  const plan = planAutonomousSettlementMigration(state, frontierHalo());
  assert.ok(plan);
  assert.equal(plan.agentId, pregnant.id);
});

test("a sole living parent is costlier to migrate than a parent leaving a co-parent", () => {
  const state = migrationWorld();
  const template = state.agents.find((agent) => agent.role === "builder");
  assert.ok(template);
  const soleParent = migrationBuilder(template, "agent-a-sole-parent", 95);
  const coParentCandidate = migrationBuilder(template, "agent-z-coparent", 70);
  const residentCoParent = structuredClone(template);
  residentCoParent.id = "agent-resident-coparent";
  residentCoParent.autonomy = false;
  residentCoParent.energy = 80;
  residentCoParent.position = { x: 18, y: 11 };
  delete residentCoParent.task;
  delete residentCoParent.pregnancy;

  const soleChild = structuredClone(template);
  soleChild.id = "agent-sole-child";
  soleChild.autonomy = false;
  soleChild.lifeStage = "infant";
  soleChild.birthTick = 1;
  soleChild.position = { x: 19, y: 10 };
  soleChild.parents = [soleParent.id, "agent-missing-parent"];
  delete soleChild.task;
  delete soleChild.pregnancy;

  const sharedChild = structuredClone(template);
  sharedChild.id = "agent-shared-child";
  sharedChild.autonomy = false;
  sharedChild.lifeStage = "infant";
  sharedChild.birthTick = 1;
  sharedChild.position = { x: 20, y: 10 };
  sharedChild.parents = [coParentCandidate.id, residentCoParent.id];
  delete sharedChild.task;
  delete sharedChild.pregnancy;

  state.agents = [soleParent, coParentCandidate, residentCoParent, soleChild, sharedChild];

  const plan = planAutonomousSettlementMigration(state, frontierHalo());
  assert.ok(plan);
  assert.equal(plan.agentId, coParentCandidate.id);
});
