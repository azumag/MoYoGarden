from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    if old not in text:
        raise RuntimeError(f"patch anchor missing: {old[:80]!r}")
    return text.replace(old, new, 1)


demography = Path("src/demography.ts")
text = demography.read_text()
text = replace_once(
    text,
    "const POPULATION_CAREGIVER_ENERGY_COST = 2;\nconst POPULATION_RELATIONSHIP_MEMORY_LIMIT = 8;",
    "const POPULATION_CAREGIVER_ENERGY_COST = 2;\n"
    "const POPULATION_FOOD_INSECURITY_HEALTH_COST = 1;\n"
    "export const POPULATION_CARE_WORK_RECOVERY_ENERGY = 35;\n"
    "const POPULATION_RELATIONSHIP_MEMORY_LIMIT = 8;",
)
marker = """function dependentCaregiver(state: WorldState, dependent: Agent): Agent | undefined {
  const caregiverId = dependentCaregiverId(state, dependent);
  return caregiverId === undefined
    ? undefined
    : state.agents.find((candidate) => candidate.id === caregiverId);
}
"""
addition = marker + """
export type DemographicWorkRecoveryReason = "pregnancy" | "dependent-care";

/**
 * Derive temporary work recovery from existing low-level demographic state.
 *
 * Pregnancy and dependent care already consume food and energy on the compressed
 * demographic cadence. Once that accumulated energy pressure reaches the same
 * reserve used to gate conception, autonomous work yields to recovery until the
 * agent has rebuilt a small reserve. Explicit external commands remain
 * authoritative, and no new persisted cooldown/state field is needed.
 */
export function demographicWorkRecoveryReasons(
  state: WorldState,
): Map<string, DemographicWorkRecoveryReason> {
  const reasons = new Map<string, DemographicWorkRecoveryReason>();
  const eligible = (agent: Agent): boolean =>
    agent.autonomy &&
    agent.hp > 0 &&
    agent.energy <= POPULATION_CARE_WORK_RECOVERY_ENERGY &&
    agent.task?.source !== "external";

  for (const agent of state.agents) {
    if (
      eligible(agent) &&
      agent.pregnancy !== undefined &&
      agent.pregnancy.dueAtTick > state.tick
    ) {
      reasons.set(agent.id, "pregnancy");
    }
  }

  for (const dependent of state.agents) {
    if (
      dependent.hp <= 0 ||
      (dependent.lifeStage !== "infant" && dependent.lifeStage !== "juvenile")
    ) {
      continue;
    }
    const caregiverId = dependentCaregiverId(state, dependent);
    if (caregiverId === undefined || reasons.has(caregiverId)) continue;
    const caregiver = state.agents.find((candidate) => candidate.id === caregiverId);
    if (caregiver !== undefined && eligible(caregiver)) {
      reasons.set(caregiverId, "dependent-care");
    }
  }
  return reasons;
}
"""
text = replace_once(text, marker, addition)
text = replace_once(
    text,
    """      if (!nourished) {
        agent.status = agent.lifeStage === "elder"
          ? "elder; pregnant; food insecure"
          : "pregnant; food insecure";
      }""",
    """      if (!nourished) {
        if (agent.hp > 1) {
          agent.hp = Math.max(1, agent.hp - POPULATION_FOOD_INSECURITY_HEALTH_COST);
        }
        agent.status = agent.lifeStage === "elder"
          ? "elder; pregnant; food insecure"
          : "pregnant; food insecure";
      }""",
)
text = replace_once(
    text,
    """    } else {
      dependent.energy = Math.max(
        0,
        dependent.energy - POPULATION_DEPENDENT_HUNGER_ENERGY_COST,
      );
      dependent.status = `${dependent.lifeStage}; food insecure`;
    }""",
    """    } else {
      dependent.energy = Math.max(
        0,
        dependent.energy - POPULATION_DEPENDENT_HUNGER_ENERGY_COST,
      );
      if (dependent.hp > 1) {
        dependent.hp = Math.max(
          1,
          dependent.hp - POPULATION_FOOD_INSECURITY_HEALTH_COST,
        );
      }
      dependent.status = `${dependent.lifeStage}; food insecure`;
    }""",
)
demography.write_text(text)

simulation = Path("src/simulation.ts")
text = simulation.read_text()
text = replace_once(
    text,
    'import { createRandom } from "./prng.js";\nimport {',
    'import { demographicWorkRecoveryReasons } from "./demography.js";\n'
    'import { createRandom } from "./prng.js";\nimport {',
)
text = replace_once(
    text,
    """  const agents = [...state.agents].sort((a, b) => a.id.localeCompare(b.id));
  for (const agent of agents) {
    if (agent.task === undefined && agent.autonomy) {
      const plannedTask = autonomyTask(state, agent);
      if (plannedTask !== undefined) agent.task = plannedTask;
    }
    executeTask(state, agent);
  }""",
    """  const demographicRecovery = demographicWorkRecoveryReasons(state);
  const agents = [...state.agents].sort((a, b) => a.id.localeCompare(b.id));
  for (const agent of agents) {
    const recoveryReason = demographicRecovery.get(agent.id);
    if (recoveryReason !== undefined) {
      // Preserve the existing autonomous task as intent, but spend this tick
      // recovering instead of moving/gathering/building/trading. Once energy is
      // above the demographic reserve threshold the same task can resume.
      agent.energy = Math.min(100, agent.energy + 1);
      agent.status = recoveryReason === "pregnancy"
        ? "resting during pregnancy"
        : "resting after dependent care";
      continue;
    }
    if (agent.task === undefined && agent.autonomy) {
      const plannedTask = autonomyTask(state, agent);
      if (plannedTask !== undefined) agent.task = plannedTask;
    }
    executeTask(state, agent);
  }""",
)
simulation.write_text(text)

maintenance = Path("tests/population-maintenance.test.mjs")
text = maintenance.read_text()
text = replace_once(
    text,
    """  assert.equal(parent.energy, 72);
  assert.equal(parent.status, "pregnant; food insecure");
  assert.equal(child.energy, 42);
  assert.equal(child.status, "infant; food insecure");""",
    """  assert.equal(parent.energy, 72);
  assert.equal(parent.hp, 99);
  assert.equal(parent.status, "pregnant; food insecure");
  assert.equal(child.energy, 42);
  assert.equal(child.hp, 99);
  assert.equal(child.status, "infant; food insecure");""",
)
maintenance.write_text(text)

Path("tests/population-work-availability.test.mjs").write_text('''import assert from "node:assert/strict";
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
''')
