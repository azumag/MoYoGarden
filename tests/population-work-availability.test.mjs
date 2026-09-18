import assert from "node:assert/strict";
import test from "node:test";
import { demographicWorkRecoveryReasons, POPULATION_CARE_WORK_RECOVERY_ENERGY } from "../dist-ts/src/demography.js";
import { emptyInventory } from "../dist-ts/src/protocol.js";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function fixture() {
  const state = createInitialWorld({ seed: 9411, width: 40, height: 24, regionId: "garden-1" });
  for (const agent of state.agents) {
    agent.autonomy = false;
    delete agent.task;
    delete agent.pregnancy;
  }
  const parent = state.agents[0];
  const partner = state.agents[1];
  assert.ok(parent);
  assert.ok(partner);
  parent.autonomy = true;
  parent.energy = POPULATION_CARE_WORK_RECOVERY_ENERGY;
  parent.lifeStage = "adult";
  parent.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "move",
    target: { ...parent.position },
  };
  return { state, parent, partner };
}

test("low-energy pregnancy yields autonomous work to recovery without losing intent", () => {
  const { state, parent, partner } = fixture();
  parent.pregnancy = {
    partnerId: partner.id,
    conceivedAtTick: state.tick,
    dueAtTick: state.tick + 100,
  };

  const reasons = demographicWorkRecoveryReasons(state);
  assert.equal(reasons.get(parent.id), "pregnancy");

  const result = simulate(state).state;
  const after = result.agents.find((agent) => agent.id === parent.id);
  assert.ok(after);
  assert.equal(after.energy, POPULATION_CARE_WORK_RECOVERY_ENERGY + 1);
  assert.equal(after.status, "resting during pregnancy");
  assert.equal(after.task?.type, "move");
  assert.deepEqual(after.position, parent.position);
});

test("low-energy caregiver recovery derives from an actual dependent relationship", () => {
  const { state, parent, partner } = fixture();
  const child = {
    ...structuredClone(partner),
    id: "agent-dependent-care-test",
    name: "Dependent",
    position: { ...parent.position },
    hp: 100,
    energy: 50,
    capacity: 1,
    inventory: emptyInventory(),
    autonomy: false,
    goal: "Grow with parental care",
    status: "infant; dependent on parents",
    birthTick: state.tick,
    lifeStage: "infant",
    parents: [parent.id, partner.id],
  };
  delete child.task;
  delete child.pregnancy;
  state.agents.push(child);

  const reasons = demographicWorkRecoveryReasons(state);
  assert.equal(reasons.get(parent.id), "dependent-care");

  const result = simulate(state).state;
  const after = result.agents.find((agent) => agent.id === parent.id);
  assert.ok(after);
  assert.equal(after.energy, POPULATION_CARE_WORK_RECOVERY_ENERGY + 1);
  assert.equal(after.status, "resting after dependent care");
  assert.equal(after.task?.type, "move");
});

test("explicit external work remains authoritative during demographic recovery", () => {
  const { state, parent, partner } = fixture();
  parent.pregnancy = {
    partnerId: partner.id,
    conceivedAtTick: state.tick,
    dueAtTick: state.tick + 100,
  };
  parent.task = {
    source: "external",
    issuedAtTick: state.tick,
    expiresAtTick: state.tick + 10,
    type: "move",
    target: { ...parent.position },
  };

  assert.equal(demographicWorkRecoveryReasons(state).has(parent.id), false);
  const result = simulate(state).state;
  const after = result.agents.find((agent) => agent.id === parent.id);
  assert.ok(after);
  assert.notEqual(after.status, "resting during pregnancy");
});
