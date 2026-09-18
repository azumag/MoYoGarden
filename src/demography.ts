import { hexGridDistance } from "./hex-grid.js";
import type { Agent, AgentHeritableTraits, WorldEvent, WorldState } from "./protocol.js";
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
const POPULATION_FOOD_INSECURITY_HEALTH_COST = 1;
export const POPULATION_CARE_WORK_RECOVERY_ENERGY = 35;
const POPULATION_RELATIONSHIP_MEMORY_LIMIT = 8;
const POPULATION_RELATIONSHIP_FAMILIARITY_MAX = 32;
const GLOBAL_AGENT_PREFIX = "agent-global:";
export const POPULATION_TRAIT_MIN = 0.9;
export const POPULATION_TRAIT_MAX = 1.1;
export const POPULATION_TRAIT_MUTATION_MAX = 0.02;

function demographicHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function boundedTrait(value: number | undefined): number {
  const finite = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.max(POPULATION_TRAIT_MIN, Math.min(POPULATION_TRAIT_MAX, finite));
}

function roundedTrait(value: number): number {
  return Math.round(boundedTrait(value) * 10_000) / 10_000;
}

function traitMutation(childId: string, trait: keyof AgentHeritableTraits): number {
  const unit = (demographicHash(`${childId}:${trait}`) % 2_001) / 1_000 - 1;
  return unit * POPULATION_TRAIT_MUTATION_MAX;
}

export function normalizedHeritableTraits(
  agent: Pick<Agent, "heritableTraits"> | undefined,
): AgentHeritableTraits {
  return {
    vitality: roundedTrait(agent?.heritableTraits?.vitality ?? 1),
    carryingCapacity: roundedTrait(agent?.heritableTraits?.carryingCapacity ?? 1),
  };
}

export function inheritHeritableTraits(
  gestationalParent: Pick<Agent, "heritableTraits">,
  partnerTraits: AgentHeritableTraits | undefined,
  childId: string,
): AgentHeritableTraits {
  const first = normalizedHeritableTraits(gestationalParent);
  const second = {
    vitality: roundedTrait(partnerTraits?.vitality ?? 1),
    carryingCapacity: roundedTrait(partnerTraits?.carryingCapacity ?? 1),
  };
  return {
    vitality: roundedTrait(
      (first.vitality + second.vitality) / 2 + traitMutation(childId, "vitality"),
    ),
    carryingCapacity: roundedTrait(
      (first.carryingCapacity + second.carryingCapacity) / 2 +
        traitMutation(childId, "carryingCapacity"),
    ),
  };
}

export function adultCapacityForTraits(
  baseCapacity: number,
  agent: Pick<Agent, "heritableTraits">,
): number {
  const traits = normalizedHeritableTraits(agent);
  return Math.max(1, Math.round(baseCapacity * traits.carryingCapacity));
}

export function naturalLifespanTicks(agentId: string, vitality = 1): number {
  const extraDays = demographicHash(agentId) % (POPULATION_LIFESPAN_VARIATION_DAYS + 1);
  const baseline = POPULATION_MIN_LIFESPAN_TICKS + extraDays * POPULATION_DAY_TICKS;
  return Math.round(baseline * boundedTrait(vitality));
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

function socialFamiliarityBetween(
  state: WorldState,
  left: Agent,
  right: Agent,
): number {
  const familiarityFrom = (source: Agent, target: Agent): number =>
    (source.socialMemory ?? []).reduce((best, entry) => {
      if (!lineageReferenceMatchesAgent(state, target.id, entry.agentId)) return best;
      const familiarity = Number.isFinite(entry.familiarity)
        ? Math.max(0, entry.familiarity)
        : 0;
      return Math.max(best, familiarity);
    }, 0);
  return Math.max(familiarityFrom(left, right), familiarityFrom(right, left));
}

export function dependentCaregiverId(
  state: WorldState,
  dependent: Agent,
): string | undefined {
  const parents = (dependent.parents ?? [])
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
  if (parents[0] !== undefined) return parents[0].id;

  // When no living parent currently owns this region, allow an existing
  // relationship to provide care instead of assigning a magical stranger.
  // This is deliberately a fallback: a living local parent always remains
  // authoritative, and strangers with zero familiarity never qualify.
  const guardians = state.agents
    .filter((candidate) =>
      candidate.id !== dependent.id &&
      candidate.factionId === dependent.factionId &&
      candidate.hp > 0 &&
      candidate.lifeStage !== "infant" &&
      candidate.lifeStage !== "juvenile"
    )
    .map((candidate) => ({
      candidate,
      familiarity: socialFamiliarityBetween(state, candidate, dependent),
    }))
    .filter(({ familiarity }) => familiarity > 0)
    .sort((a, b) =>
      b.familiarity - a.familiarity ||
      hexGridDistance(a.candidate.position, dependent.position) -
        hexGridDistance(b.candidate.position, dependent.position) ||
      b.candidate.energy - a.candidate.energy ||
      a.candidate.id.localeCompare(b.candidate.id)
    );
  return guardians[0]?.candidate.id;
}

function dependentCaregiver(state: WorldState, dependent: Agent): Agent | undefined {
  const caregiverId = dependentCaregiverId(state, dependent);
  return caregiverId === undefined
    ? undefined
    : state.agents.find((candidate) => candidate.id === caregiverId);
}

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

function constructionStructureId(event: WorldEvent): string | undefined {
  if (
    event.kind !== "construction_started" &&
    event.kind !== "construction_progress" &&
    event.kind !== "construction_completed"
  ) {
    return undefined;
  }
  const structureId = event.data?.structureId;
  return typeof structureId === "string" && structureId.length > 0
    ? structureId
    : undefined;
}

function rememberCollaborator(agent: Agent, otherId: string, tick: number): boolean {
  if (agent.id === otherId) return false;
  const memory = (agent.socialMemory ?? []).map((entry) => ({ ...entry }));
  const existing = memory.find((entry) => entry.agentId === otherId);
  if (
    existing !== undefined &&
    Number.isFinite(existing.lastInteractionTick) &&
    existing.lastInteractionTick >= tick
  ) {
    return false;
  }

  if (existing === undefined) {
    memory.push({ agentId: otherId, familiarity: 1, lastInteractionTick: tick });
  } else {
    const familiarity = Number.isFinite(existing.familiarity)
      ? Math.max(0, existing.familiarity)
      : 0;
    existing.familiarity = Math.min(
      POPULATION_RELATIONSHIP_FAMILIARITY_MAX,
      familiarity + 1,
    );
    existing.lastInteractionTick = tick;
  }
  memory.sort((a, b) =>
    b.familiarity - a.familiarity ||
    b.lastInteractionTick - a.lastInteractionTick ||
    a.agentId.localeCompare(b.agentId)
  );
  agent.socialMemory = memory.slice(0, POPULATION_RELATIONSHIP_MEMORY_LIMIT);
  return true;
}

/**
 * Convert retained shared-construction history into the same bounded relationship
 * memory used by ordinary conversations. This keeps pair formation bottom-up:
 * agents can become familiar because they repeatedly worked on the same physical
 * structure, not only because a periodic conversation happened to fire nearby.
 *
 * Event history is only a compatibility/evidence source. Once a pair has absorbed
 * the newest shared-work tick, lastInteractionTick makes subsequent ticks
 * idempotent even while those events remain in the bounded event log.
 */
export function applyConstructionCollaborationFamiliarity(state: WorldState): number {
  const agentsById = new Map(state.agents.map((agent) => [agent.id, agent]));
  const participantsByStructure = new Map<string, Map<string, number>>();

  for (const event of state.events) {
    if (event.tick > state.tick || event.agentId === undefined) continue;
    if (!agentsById.has(event.agentId)) continue;
    const structureId = constructionStructureId(event);
    if (structureId === undefined) continue;
    const participants = participantsByStructure.get(structureId) ?? new Map<string, number>();
    participants.set(
      event.agentId,
      Math.max(participants.get(event.agentId) ?? Number.NEGATIVE_INFINITY, event.tick),
    );
    participantsByStructure.set(structureId, participants);
  }

  let updatedPairs = 0;
  for (const participants of participantsByStructure.values()) {
    const entries = [...participants.entries()].sort(([firstId], [secondId]) =>
      firstId.localeCompare(secondId)
    );
    for (let firstIndex = 0; firstIndex < entries.length; firstIndex += 1) {
      const firstEntry = entries[firstIndex];
      if (firstEntry === undefined) continue;
      const [firstId, firstTick] = firstEntry;
      const first = agentsById.get(firstId);
      if (first === undefined || first.hp <= 0) continue;

      for (let secondIndex = firstIndex + 1; secondIndex < entries.length; secondIndex += 1) {
        const secondEntry = entries[secondIndex];
        if (secondEntry === undefined) continue;
        const [secondId, secondTick] = secondEntry;
        const second = agentsById.get(secondId);
        if (
          second === undefined ||
          second.hp <= 0 ||
          second.factionId !== first.factionId
        ) {
          continue;
        }

        const collaborationTick = Math.max(firstTick, secondTick);
        const firstUpdated = rememberCollaborator(first, second.id, collaborationTick);
        const secondUpdated = rememberCollaborator(second, first.id, collaborationTick);
        if (firstUpdated || secondUpdated) updatedPairs += 1;
      }
    }
  }
  return updatedPairs;
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
        if (agent.hp > 1) {
          agent.hp = Math.max(1, agent.hp - POPULATION_FOOD_INSECURITY_HEALTH_COST);
        }
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
      if (dependent.hp > 1) {
        dependent.hp = Math.max(
          1,
          dependent.hp - POPULATION_FOOD_INSECURITY_HEALTH_COST,
        );
      }
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
    if (age >= naturalLifespanTicks(agent.id, agent.heritableTraits?.vitality)) continue;

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
  applyConstructionCollaborationFamiliarity(state);
  applyPopulationMaintenance(state);
}
