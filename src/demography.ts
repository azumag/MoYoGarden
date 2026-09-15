import type { WorldState } from "./protocol.js";

// Demographic time is intentionally compressed to keep biological causality visible
// in a persistent world while preserving the production 10-second virtual tick.
export const POPULATION_DAY_TICKS = 8_640;
export const POPULATION_ELDER_AGE_TICKS = POPULATION_DAY_TICKS * 18;
export const POPULATION_MIN_LIFESPAN_TICKS = POPULATION_DAY_TICKS * 24;
export const POPULATION_LIFESPAN_VARIATION_DAYS = 8;
export const POPULATION_MAX_LIFESPAN_TICKS =
  POPULATION_MIN_LIFESPAN_TICKS + POPULATION_DAY_TICKS * POPULATION_LIFESPAN_VARIATION_DAYS;

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
      if (agent.pregnancy !== undefined) delete agent.pregnancy;
    }
    survivors.push(agent);
  }
  state.agents = survivors;
}
