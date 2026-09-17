import { hexGridDistance } from "./hex-grid.js";
import type { Agent, WorldState } from "./protocol.js";
import { activeFactionStructures, getFaction } from "./world.js";

// Demographic time is intentionally compressed to keep biological causality visible
// in a persistent world while preserving the production 10-second virtual tick.
export const POPULATION_DAY_TICKS = 8_640;
export const POPULATION_ELDER_AGE_TICKS = POPULATION_DAY_TICKS * 18;
export const POPULATION_MIN_LIFESPAN_TICKS = POPULATION_DAY_TICKS * 24;
export const POPULATION_LIFESPAN_VARIATION_DAYS = 8;
export const POPULATION_MAX_LIFESPAN_TICKS =
  POPULATION_MIN_LIFESPAN_TICKS + POPULATION_DAY_TICKS * POPULATION_LIFESPAN_VARIATION_DAYS;

// Pregnancy and dependent care are continuous costs rather than a one-off birth
// payment. Charging twice per compressed day keeps the feedback visible without
// adding per-tick storage writes or changing persisted schema.
export const POPULATION_MAINTENANCE_INTERVAL_TICKS = POPULATION_DAY_TICKS / 2;
const POPULATION_PREGNANCY_FOOD_COST = 1;
const POPULATION_DEPENDENT_FOOD_COST = 1;
const POPULATION_PREGNANCY_ENERGY_COST = 2;
const POPULATION_PREGNANCY_HUNGER_ENERGY_COST = 6;
const POPULATION_DEPENDENT_ENERGY_RECOVERY = 6;
const POPULATION_DEPENDENT_HUNGER_ENERGY_COST = 8;
const POPULATION_CAREGIVER_ENERGY_COST = 2;
const GLOBAL_AGENT_PREFIX = "agent-global:";

function demographicHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function naturalLifespanTicks(agentId: string): number {
  const extraDays = demographicHash(agentId) % (POPULATION_LIFESPAN_VARIATION_DAYS + 1);
  return POPULATION_MIN_LIFESPAN_TICKS + extraDays * POPULATION_DAY_TICKS;
}

function consumeStoredFood(state: WorldState, factionId: string, amount: number): boolean {
  const faction = getFaction(state, factionId);
  if (faction === undefined || faction.resources.food < amount) return false;
  const storages = activeFactionStructures(state, factionId)
    .filter((structure) => structure.storage.food > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const storedFood = storages.reduce((sum, structure) => sum + structure.storage.food, 0);
  if (storedFood < amount) return false;

  faction.resources.food -= amount;
  let remaining = amount;
  for (const structure of storages) {
    const taken = Math.min(remaining, structure.storage.food);
    structure.storage.food -= taken;
    remaining -= taken;
    if (remaining === 0) break;
  }
  return true;
}

function lineageReferenceMatchesAgent(
  state: WorldState,
  candidateId: string,
  referenceId: string,
): boolean {
  if (candidateId === referenceId) return true;
  const canonical = (agentId: string): string =>
    agentId.startsWith(GLOBAL_AGENT_PREFIX)
      ? agentId
      : `${GLOBAL_AGENT_PREFIX}${state.regionId}:${agentId}`;
  return canonical(candidateId) === canonical(referenceId);
}

export function dependentCaregiverId(
  state: WorldState,
  dependent: Agent,
): string | undefined {
  const candidates = (dependent.parents ?? [])
    .flatMap((parentId) => {
      const parent = state.agents.find((candidate) =>
        lineageReferenceMatchesAgent(state, candidate.id, parentId) &&
        candidate.factionId === dependent.factionId &&
        candidate.hp > 0
      );
      return parent === undefined ? [] : [parent];
    })
    .sort((a, b) =>
      hexGridDistance(a.position, dependent.position) -
        hexGridDistance(b.position, dependent.position) ||
      b.energy - a.energy ||
      a.id.localeCompare(b.id)
    );
  return candidates[0]?.id;
}

function dependentCaregiver(state: WorldState, dependent: Agent): Agent | undefined {
  const caregiverId = dependentCaregiverId(state, dependent);
  return caregiverId === undefined
    ? undefined
    : state.agents.find((candidate) => candidate.id === caregiverId);
}

/**
 * Apply coarse demographic maintenance costs on the same virtual-time axis as
 * aging. Food comes out of the existing faction/storage ledger, so pregnancy and
 * childhood now compete with work, stockpiles, and future conceptions instead of
 * being free between conception and birth/adulthood.
 */
export function applyPopulationMaintenance(state: WorldState): void {
  if (
    state.tick === 0 ||
    state.tick % POPULATION_MAINTENANCE_INTERVAL_TICKS !== 0
  ) {
    return;
  }

  const agents = [...state.agents].sort((a, b) => a.id.localeCompare(b.id));
  for (const agent of agents) {
    if (agent.pregnancy !== undefined && agent.pregnancy.dueAtTick > state.tick) {
      const nourished = consumeStoredFood(
        state,
        agent.factionId,
        POPULATION_PREGNANCY_FOOD_COST,
      );
      agent.energy = Math.max(
        0,
        agent.energy - (
          nourished
            ? POPULATION_PREGNANCY_ENERGY_COST
            : POPULATION_PREGNANCY_HUNGER_ENERGY_COST
        ),
      );
      if (!nourished) {
        agent.status = agent.lifeStage === "elder"
          ? "elder; pregnant; food insecure"
          : "pregnant; food insecure";
      }
    }
  }

  for (const dependent of agents) {
    if (
      (dependent.lifeStage !== "infant" && dependent.lifeStage !== "juvenile") ||
      dependent.birthTick === undefined ||
      state.tick <= dependent.birthTick
    ) {
      continue;
    }

    const nourished = consumeStoredFood(
      state,
      dependent.factionId,
      POPULATION_DEPENDENT_FOOD_COST,
    );
    if (nourished) {
      dependent.energy = Math.min(
        100,
        dependent.energy + POPULATION_DEPENDENT_ENERGY_RECOVERY,
      );
      if (dependent.status.includes("food insecure")) {
        dependent.status = dependent.lifeStage === "infant"
          ? "infant; dependent on parents"
          : "juvenile; growing with the settlement";
      }
    } else {
      dependent.energy = Math.max(
        0,
        dependent.energy - POPULATION_DEPENDENT_HUNGER_ENERGY_COST,
      );
      dependent.status = `${dependent.lifeStage}; food insecure`;
    }

    const caregiver = dependentCaregiver(state, dependent);
    if (caregiver !== undefined) {
      caregiver.energy = Math.max(0, caregiver.energy - POPULATION_CAREGIVER_ENERGY_COST);
    }
  }
}

export function applyPopulationAging(state: WorldState): void {
  const survivors = [];
  for (const agent of state.agents) {
    // Legacy founders have no trustworthy birth date. Keep them as adult founders
    // instead of inventing an age that could kill persisted production residents.
    if (agent.birthTick === undefined) {
      survivors.push(agent);
      continue;
    }

    const age = Math.max(0, state.tick - agent.birthTick);
    if (age >= naturalLifespanTicks(agent.id)) continue;

    if (age >= POPULATION_ELDER_AGE_TICKS && agent.lifeStage !== "elder") {
      agent.lifeStage = "elder";
      agent.status = "elder; retired from reproduction";
      // Do not cancel an already-conceived pregnancy at the elder threshold.
      // Reproduction planning already excludes elders from new conceptions, while
      // an existing gestation should still run to its due tick causally.
    }
    survivors.push(agent);
  }
  state.agents = survivors;
  applyPopulationMaintenance(state);
}
