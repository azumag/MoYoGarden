import { isHexGridCell } from "./hex-grid.js";

// Match the simulation's infectious threshold and reservoir cleanup epsilon.
// These are observations of existing state, not client-side disease dynamics.
const INFECTIOUS_THRESHOLD = 0.12;
const RESERVOIR_EPSILON = 0.0001;
const RESOURCE_KINDS = new Set(["wood", "stone", "food"]);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Read-only observations of owned logical hexes; unknown measurements stay unknown. */
export function summarizeWorld(state) {
  const width = state?.width;
  const height = state?.height;
  const validExtent = Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0;
  const inside = (position) => validExtent && isHexGridCell(position, width, height);
  let activeCells = 0;
  let population = 0;
  let energyTotal = 0;
  let energyCount = 0;
  let infectiousAgents = 0;
  let contaminatedCells = 0;
  let resourceAmount = 0;
  let resourceCapacity = 0;
  const occupancy = new Map();

  for (const tile of Array.isArray(state?.tiles) ? state.tiles : []) {
    if (!inside(tile)) continue;
    activeCells += 1;
    if (Number.isFinite(tile.pathogenReservoir) && clamp(tile.pathogenReservoir, 0, 1) > RESERVOIR_EPSILON) {
      contaminatedCells += 1;
    }
    const resource = tile.resource;
    if (
      !RESOURCE_KINDS.has(resource?.kind) ||
      !Number.isFinite(resource.amount) ||
      !Number.isFinite(resource.maxAmount) ||
      resource.maxAmount <= 0
    ) continue;
    resourceAmount += clamp(resource.amount, 0, resource.maxAmount);
    resourceCapacity += resource.maxAmount;
  }

  for (const agent of Array.isArray(state?.agents) ? state.agents : []) {
    if (!inside(agent?.position)) continue;
    population += 1;
    const key = `${agent.position.x},${agent.position.y}`;
    occupancy.set(key, (occupancy.get(key) ?? 0) + 1);
    if (Number.isFinite(agent.energy)) {
      energyTotal += clamp(agent.energy, 0, 100);
      energyCount += 1;
    }
    if (Number.isFinite(agent.pathogenLoad) && clamp(agent.pathogenLoad, 0, 1) > INFECTIOUS_THRESHOLD) {
      infectiousAgents += 1;
    }
  }

  let maxCrowding = 0;
  let crowdedCells = 0;
  for (const count of occupancy.values()) {
    maxCrowding = Math.max(maxCrowding, count);
    if (count >= 3) crowdedCells += 1;
  }
  return {
    activeCells,
    population,
    meanEnergy: energyCount > 0 ? energyTotal / energyCount : null,
    infectiousAgents,
    contaminatedCells,
    resourceRatio: resourceCapacity > 0 && Number.isFinite(resourceCapacity) && Number.isFinite(resourceAmount)
      ? resourceAmount / resourceCapacity
      : null,
    maxCrowding,
    crowdedCells,
  };
}

/** Bounded, in-memory samples for one monotonically advancing regional world. */
export function createObservationHistory(limit = 60) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("history limit must be a positive integer");
  let identity;
  let entries = [];
  const snapshot = () => entries.map((entry) => ({ ...entry }));
  return {
    sample(state, summary = summarizeWorld(state)) {
      const nextIdentity = [state?.worldId, state?.regionId, state?.seed];
      if (identity === undefined || nextIdentity.some((value, index) => !Object.is(value, identity[index]))) {
        entries = [];
        identity = nextIdentity;
      }
      const tick = state?.tick;
      if (!Number.isInteger(tick) || tick < 0) return snapshot();
      const previous = entries.at(-1);
      if (previous && tick < previous.tick) entries = [];
      const entry = {
        tick,
        population: summary.population,
        resourceRatio: summary.resourceRatio,
        meanEnergy: summary.meanEnergy,
      };
      if (entries.at(-1)?.tick === tick) entries[entries.length - 1] = entry;
      else entries.push(entry);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      return snapshot();
    },
  };
}
