import {
  BUILD_RECIPES,
  DEFAULT_SIMULATION_CONFIG,
  type Agent,
  type AgentTask,
  type BuildTask,
  type CommandReceipt,
  emptyInventory,
  inventoryTotal,
  manhattanDistance,
  type GridPosition,
  type Inventory,
  type ResourceKind,
  RESOURCE_KINDS,
  samePosition,
  type SimulationConfig,
  type Structure,
  type StructureType,
  type Tile,
  type WorldCommand,
  type WorldEvent,
  type WorldState,
} from "./protocol.js";
import { createRandom } from "./prng.js";
import {
  activeFactionStructures,
  ensureTileElevations,
  getAgent,
  getFaction,
  getStructure,
  getTile,
  inBounds,
  isPassable,
  nearestFactionStructure,
} from "./world.js";

export interface SimulationResult {
  state: WorldState;
  receipts: CommandReceipt[];
}

const NEIGHBORS: readonly GridPosition[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

const WATER_MOISTURE_RADIUS = 4;

export function surfaceMoistureAt(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
): number {
  const tile = getTile(state, position);
  if (tile === undefined) return 0;
  if (tile.terrain === "water") return 1;

  let waterInfluence = 0;
  for (let dy = -WATER_MOISTURE_RADIUS; dy <= WATER_MOISTURE_RADIUS; dy += 1) {
    for (let dx = -WATER_MOISTURE_RADIUS; dx <= WATER_MOISTURE_RADIUS; dx += 1) {
      const distance = Math.abs(dx) + Math.abs(dy);
      if (distance === 0 || distance > WATER_MOISTURE_RADIUS) continue;
      const neighbor = getTile(state, { x: position.x + dx, y: position.y + dy });
      if (neighbor?.terrain !== "water") continue;
      waterInfluence = Math.max(
        waterInfluence,
        (WATER_MOISTURE_RADIUS + 1 - distance) / WATER_MOISTURE_RADIUS,
      );
    }
  }

  const vegetationCover =
    tile.resource?.kind === "wood" && tile.resource.maxAmount > 0
      ? tile.resource.amount / tile.resource.maxAmount
      : 0;
  const elevation = Number.isFinite(tile.elevation) ? tile.elevation ?? 0.5 : 0.5;
  const lowlandRetention = (1 - elevation) * 0.12;
  return Math.min(
    1,
    0.05 + lowlandRetention + waterInfluence * 0.7 + vegetationCover * 0.16,
  );
}

export function resourceRegrowthChance(state: WorldState, tile: Tile): number {
  if (tile.resource === undefined || tile.resource.kind === "stone") return 0.18;
  const moisture = surfaceMoistureAt(state, tile);
  return tile.resource.kind === "wood"
    ? Math.min(0.32, 0.08 + moisture * 0.22)
    : Math.min(0.34, 0.06 + moisture * 0.26);
}

function addEvent(
  state: WorldState,
  event: Omit<WorldEvent, "id" | "tick"> & { tick?: number },
): void {
  const sequence = state.events.length + 1;
  state.events.push({
    ...event,
    id: `event-${state.tick}-${sequence}`,
    tick: event.tick ?? state.tick,
  });
}

function commandRejected(state: WorldState, command: WorldCommand, reason: string): CommandReceipt {
  addEvent(state, {
    kind: "command_rejected",
    message: `Command ${command.id} rejected: ${reason}`,
    agentId: command.agentId,
    data: { commandId: command.id, type: command.type, reason },
  });
  return { accepted: false, commandId: command.id, tick: state.tick, reason };
}

function commandAccepted(state: WorldState, command: WorldCommand): CommandReceipt {
  addEvent(state, {
    kind: "command_accepted",
    message: `${command.agentId} accepted ${command.type}.`,
    agentId: command.agentId,
    data: { commandId: command.id, type: command.type },
  });
  return { accepted: true, commandId: command.id, tick: state.tick };
}

function isTargetValid(state: WorldState, target: GridPosition): boolean {
  return inBounds(state, target) && isPassable(state, target);
}

function taskBase(state: WorldState, config: SimulationConfig): Pick<AgentTask, "source" | "issuedAtTick" | "expiresAtTick"> {
  return {
    source: "external",
    issuedAtTick: state.tick,
    expiresAtTick: state.tick + config.externalTaskTtl,
  };
}

function applyCommand(
  state: WorldState,
  command: WorldCommand,
  config: SimulationConfig,
): CommandReceipt {
  if (state.processedCommandIds.includes(command.id)) {
    return commandRejected(state, command, "duplicate command id");
  }
  state.processedCommandIds.push(command.id);

  const agent = getAgent(state, command.agentId);
  if (agent === undefined) return commandRejected(state, command, "unknown agent");

  const base = taskBase(state, config);
  switch (command.type) {
    case "move":
      if (!isTargetValid(state, command.target)) {
        return commandRejected(state, command, "target is outside the map or impassable");
      }
      agent.task = { ...base, type: "move", target: command.target };
      agent.status = "moving by external command";
      break;
    case "gather":
      if (command.target !== undefined && !isTargetValid(state, command.target)) {
        return commandRejected(state, command, "target is outside the map or impassable");
      }
      agent.task = command.target === undefined
        ? { ...base, type: "gather", resource: command.resource }
        : { ...base, type: "gather", resource: command.resource, target: command.target };
      agent.status = `seeking ${command.resource}`;
      break;
    case "build":
      if (!isTargetValid(state, command.target)) {
        return commandRejected(state, command, "build target is outside the map or impassable");
      }
      agent.task = {
        ...base,
        type: "build",
        structureType: command.structureType,
        target: command.target,
      };
      agent.status = `preparing ${command.structureType}`;
      break;
    case "deposit":
      if (command.structureId !== undefined) {
        const structure = getStructure(state, command.structureId);
        if (
          structure === undefined ||
          structure.factionId !== agent.factionId ||
          structure.status !== "active"
        ) {
          return commandRejected(state, command, "deposit structure is not an active owned structure");
        }
      }
      agent.task = command.structureId === undefined
        ? { ...base, type: "deposit" }
        : { ...base, type: "deposit", structureId: command.structureId };
      agent.status = "returning resources";
      break;
    case "trade":
      if (command.targetAgentId === agent.id) {
        return commandRejected(state, command, "an agent cannot trade with itself");
      }
      if (getAgent(state, command.targetAgentId) === undefined) {
        return commandRejected(state, command, "unknown trade target");
      }
      agent.task = {
        ...base,
        type: "trade",
        targetAgentId: command.targetAgentId,
        offer: command.offer,
        request: command.request,
      };
      agent.status = `seeking ${command.targetAgentId} to trade`;
      break;
    case "set_autonomy":
      agent.autonomy = command.enabled;
      if (!command.enabled && agent.task?.source === "autonomy") delete agent.task;
      agent.status = command.enabled ? "autonomy enabled" : "awaiting external commands";
      addEvent(state, {
        kind: "autonomy_changed",
        message: `${agent.name} autonomy ${command.enabled ? "enabled" : "disabled"}.`,
        agentId: agent.id,
        factionId: agent.factionId,
        position: { ...agent.position },
        data: { enabled: command.enabled },
      });
      break;
    case "set_goal":
      agent.goal = command.goal;
      addEvent(state, {
        kind: "goal_changed",
        message: `${agent.name} received a new goal: ${command.goal}`,
        agentId: agent.id,
        factionId: agent.factionId,
        position: { ...agent.position },
      });
      break;
    case "clear_task":
      delete agent.task;
      agent.status = agent.autonomy ? "replanning" : "idle";
      break;
  }

  return commandAccepted(state, command);
}

function hasInventory(inventory: Inventory, cost: Inventory): boolean {
  return RESOURCE_KINDS.every((kind) => inventory[kind] >= cost[kind]);
}

function consumeInventory(inventory: Inventory, cost: Inventory): void {
  for (const kind of RESOURCE_KINDS) inventory[kind] -= cost[kind];
}

function factionCanAfford(state: WorldState, factionId: string, cost: Inventory): boolean {
  const faction = getFaction(state, factionId);
  return faction !== undefined && hasInventory(faction.resources, cost);
}

function consumeFactionResources(state: WorldState, factionId: string, cost: Inventory): boolean {
  const faction = getFaction(state, factionId);
  if (faction === undefined || !hasInventory(faction.resources, cost)) return false;

  consumeInventory(faction.resources, cost);
  const storages = activeFactionStructures(state, factionId).sort((a, b) => a.id.localeCompare(b.id));
  for (const kind of RESOURCE_KINDS) {
    let remaining = cost[kind];
    for (const structure of storages) {
      const taken = Math.min(remaining, structure.storage[kind]);
      structure.storage[kind] -= taken;
      remaining -= taken;
      if (remaining === 0) break;
    }
  }
  return true;
}

function inventoryMissingForRecipe(inventory: Inventory, type: StructureType): ResourceKind {
  const cost = BUILD_RECIPES[type].cost;
  return RESOURCE_KINDS
    .map((kind) => ({ kind, missing: Math.max(0, cost[kind] - inventory[kind]) }))
    .sort((a, b) => b.missing - a.missing || a.kind.localeCompare(b.kind))[0]?.kind ?? "wood";
}

function factionMissingForRecipe(state: WorldState, factionId: string, type: StructureType): ResourceKind {
  const faction = getFaction(state, factionId);
  if (faction === undefined) return "wood";
  return inventoryMissingForRecipe(faction.resources, type);
}

function nextStepTowards(state: WorldState, start: GridPosition, target: GridPosition): GridPosition {
  if (samePosition(start, target)) return start;

  const queue: GridPosition[] = [start];
  const visited = new Set<string>([`${start.x},${start.y}`]);
  const previous = new Map<string, GridPosition>();
  let found = false;

  for (let cursor = 0; cursor < queue.length && !found; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) break;
    for (const delta of NEIGHBORS) {
      const next = { x: current.x + delta.x, y: current.y + delta.y };
      const key = `${next.x},${next.y}`;
      if (visited.has(key) || !isPassable(state, next)) continue;
      visited.add(key);
      previous.set(key, current);
      if (samePosition(next, target)) {
        found = true;
        break;
      }
      queue.push(next);
    }
  }

  if (!found) return start;
  let step = target;
  let parent = previous.get(`${step.x},${step.y}`);
  while (parent !== undefined && !samePosition(parent, start)) {
    step = parent;
    parent = previous.get(`${step.x},${step.y}`);
  }
  return step;
}

function moveAgent(state: WorldState, agent: Agent, target: GridPosition): boolean {
  if (samePosition(agent.position, target)) return true;
  const next = nextStepTowards(state, agent.position, target);
  if (samePosition(next, agent.position)) {
    agent.status = "path blocked";
    return false;
  }
  agent.position = next;
  agent.energy = Math.max(0, agent.energy - 1);
  agent.status = `moving to ${target.x},${target.y}`;
  addEvent(state, {
    kind: "agent_moved",
    message: `${agent.name} moved to ${next.x},${next.y}.`,
    agentId: agent.id,
    factionId: agent.factionId,
    position: { ...next },
  });
  return samePosition(next, target);
}

function nearestResource(
  state: WorldState,
  origin: GridPosition,
  resource: ResourceKind,
): GridPosition | undefined {
  const tile = state.tiles
    .filter((candidate) =>
      candidate.resource?.kind === resource &&
      candidate.resource.amount > 0 &&
      candidate.terrain !== "water"
    )
    .sort((a, b) => {
      const distance = manhattanDistance(a, origin) - manhattanDistance(b, origin);
      return distance || a.y - b.y || a.x - b.x;
    })[0];
  return tile === undefined ? undefined : { x: tile.x, y: tile.y };
}

function findBuildSite(
  state: WorldState,
  origin: GridPosition,
  factionId: string,
): GridPosition | undefined {
  const occupied = new Set(state.structures.map((structure) => `${structure.position.x},${structure.position.y}`));
  const candidates = state.tiles
    .filter((tile) => tile.terrain !== "water" && !occupied.has(`${tile.x},${tile.y}`))
    .filter((tile) => manhattanDistance(tile, origin) <= 5)
    .sort((a, b) => {
      const resourcePenaltyA = a.resource === undefined ? 0 : 1;
      const resourcePenaltyB = b.resource === undefined ? 0 : 1;
      return (
        resourcePenaltyA - resourcePenaltyB ||
        manhattanDistance(a, origin) - manhattanDistance(b, origin) ||
        a.y - b.y ||
        a.x - b.x
      );
    });

  const ownPositions = new Set(
    state.agents.filter((agent) => agent.factionId === factionId).map((agent) => `${agent.position.x},${agent.position.y}`),
  );
  const candidate =
    candidates.find((entry) => !ownPositions.has(`${entry.x},${entry.y}`)) ?? candidates[0];
  return candidate === undefined ? undefined : { x: candidate.x, y: candidate.y };
}

function autonomyTask(state: WorldState, agent: Agent): AgentTask | undefined {
  const issuedAtTick = state.tick;
  const base = { source: "autonomy" as const, issuedAtTick };
  const structures = activeFactionStructures(state, agent.factionId);
  const inventoryAmount = inventoryTotal(agent.inventory);

  if (structures.length > 0 && inventoryAmount >= Math.min(6, agent.capacity)) {
    return { ...base, type: "deposit" };
  }

  if (agent.role === "builder") {
    const camp = state.structures.find(
      (structure) => structure.factionId === agent.factionId && structure.type === "camp",
    );
    if (camp === undefined) {
      const recipe = BUILD_RECIPES.camp;
      if (hasInventory(agent.inventory, recipe.cost)) {
        const target = findBuildSite(state, agent.position, agent.factionId) ?? agent.position;
        return { ...base, type: "build", structureType: "camp", target };
      }
      const resource = inventoryMissingForRecipe(agent.inventory, "camp");
      const target = nearestResource(state, agent.position, resource);
      return target === undefined
        ? undefined
        : { ...base, type: "gather", resource, target };
    }
    if (camp.status === "building") {
      return {
        ...base,
        type: "build",
        structureType: "camp",
        target: camp.position,
        structureId: camp.id,
      };
    }

    const buildOrder: readonly StructureType[] = ["storehouse", "market", "workshop"];
    for (const type of buildOrder) {
      const existing = state.structures.find(
        (structure) => structure.factionId === agent.factionId && structure.type === type,
      );
      if (existing?.status === "building") {
        return {
          ...base,
          type: "build",
          structureType: type,
          target: existing.position,
          structureId: existing.id,
        };
      }
      if (existing === undefined) {
        if (factionCanAfford(state, agent.factionId, BUILD_RECIPES[type].cost)) {
          const target = findBuildSite(state, camp.position, agent.factionId);
          if (target !== undefined) return { ...base, type: "build", structureType: type, target };
        }
        if (inventoryAmount > 0) return { ...base, type: "deposit" };
        const resource = factionMissingForRecipe(state, agent.factionId, type);
        const target = nearestResource(state, agent.position, resource);
        return target === undefined
          ? undefined
          : { ...base, type: "gather", resource, target };
      }
    }
  }

  const resource: ResourceKind =
    agent.role === "woodcutter" ? "wood" : agent.role === "miner" ? "stone" : "food";
  const target = nearestResource(state, agent.position, resource);
  if (target !== undefined) return { ...base, type: "gather", resource, target };

  const fallback = state.tiles
    .filter((tile) => tile.terrain !== "water")
    .sort((a, b) => manhattanDistance(a, agent.position) - manhattanDistance(b, agent.position))[0];
  return fallback === undefined
    ? undefined
    : { ...base, type: "move", target: { x: fallback.x, y: fallback.y } };
}

function executeGather(state: WorldState, agent: Agent, task: Extract<AgentTask, { type: "gather" }>): void {
  if (inventoryTotal(agent.inventory) >= agent.capacity) {
    delete agent.task;
    agent.status = "inventory full";
    return;
  }
  let target = task.target;
  const targetTile = target === undefined ? undefined : getTile(state, target);
  if (
    target === undefined ||
    targetTile?.resource?.kind !== task.resource ||
    targetTile.resource.amount <= 0
  ) {
    target = nearestResource(state, agent.position, task.resource);
    if (target === undefined) {
      delete agent.task;
      agent.status = `no ${task.resource} known`;
      return;
    }
    task.target = target;
  }

  if (!samePosition(agent.position, target)) {
    moveAgent(state, agent, target);
    return;
  }

  const tile = getTile(state, agent.position);
  if (tile?.resource?.kind !== task.resource || tile.resource.amount <= 0) {
    delete agent.task;
    agent.status = `${task.resource} depleted`;
    return;
  }
  const capacityLeft = agent.capacity - inventoryTotal(agent.inventory);
  const amount = Math.min(2, tile.resource.amount, capacityLeft);
  tile.resource.amount -= amount;
  agent.inventory[task.resource] += amount;
  agent.energy = Math.max(0, agent.energy - 1);
  agent.status = `gathering ${task.resource}`;
  addEvent(state, {
    kind: "resource_gathered",
    message: `${agent.name} gathered ${amount} ${task.resource}.`,
    agentId: agent.id,
    factionId: agent.factionId,
    position: { ...agent.position },
    data: { resource: task.resource, amount },
  });

  const hasCamp = state.structures.some(
    (structure) => structure.factionId === agent.factionId && structure.type === "camp",
  );
  if (
    agent.role === "builder" &&
    !hasCamp &&
    agent.inventory[task.resource] >= BUILD_RECIPES.camp.cost[task.resource]
  ) {
    delete agent.task;
    agent.status = `${task.resource} secured for founding camp`;
  }

  if (tile.resource.amount === 0) {
    addEvent(state, {
      kind: "resource_depleted",
      message: `${task.resource} at ${tile.x},${tile.y} was depleted.`,
      position: { x: tile.x, y: tile.y },
      data: { resource: task.resource },
    });
    delete agent.task;
  }
}

function executeDeposit(state: WorldState, agent: Agent, task: Extract<AgentTask, { type: "deposit" }>): void {
  let structure = task.structureId === undefined ? undefined : getStructure(state, task.structureId);
  if (
    structure === undefined ||
    structure.factionId !== agent.factionId ||
    structure.status !== "active"
  ) {
    structure = nearestFactionStructure(state, agent.factionId, agent.position);
  }
  if (structure === undefined) {
    delete agent.task;
    agent.status = "no storage available";
    return;
  }
  task.structureId = structure.id;
  if (!samePosition(agent.position, structure.position)) {
    moveAgent(state, agent, structure.position);
    return;
  }

  const faction = getFaction(state, agent.factionId);
  if (faction === undefined) {
    delete agent.task;
    return;
  }
  const deposited = { ...agent.inventory };
  for (const kind of RESOURCE_KINDS) {
    faction.resources[kind] += agent.inventory[kind];
    structure.storage[kind] += agent.inventory[kind];
    agent.inventory[kind] = 0;
  }
  delete agent.task;
  agent.status = "resources deposited";
  addEvent(state, {
    kind: "resources_deposited",
    message: `${agent.name} deposited ${inventoryTotal(deposited)} resources at ${structure.type}.`,
    agentId: agent.id,
    factionId: agent.factionId,
    position: { ...agent.position },
    data: { deposited },
  });
}

function startConstruction(
  state: WorldState,
  agent: Agent,
  task: BuildTask,
): Structure | undefined {
  if (state.structures.some((structure) => samePosition(structure.position, task.target))) {
    agent.status = "build site occupied";
    delete agent.task;
    return undefined;
  }
  const recipe = BUILD_RECIPES[task.structureType];
  const activeStructures = activeFactionStructures(state, agent.factionId);
  const paid =
    activeStructures.length === 0
      ? hasInventory(agent.inventory, recipe.cost)
      : factionCanAfford(state, agent.factionId, recipe.cost);
  if (!paid) {
    agent.status = `missing materials for ${task.structureType}`;
    delete agent.task;
    return undefined;
  }
  if (activeStructures.length === 0) consumeInventory(agent.inventory, recipe.cost);
  else consumeFactionResources(state, agent.factionId, recipe.cost);

  const structure: Structure = {
    id: `structure-${agent.factionId}-${task.structureType}-${state.tick}-${state.structures.length + 1}`,
    factionId: agent.factionId,
    type: task.structureType,
    position: { ...task.target },
    status: "building",
    progress: 0,
    requiredProgress: recipe.work,
    storage: emptyInventory(),
  };
  state.structures.push(structure);
  task.structureId = structure.id;
  addEvent(state, {
    kind: "construction_started",
    message: `${agent.name} started a ${task.structureType}.`,
    agentId: agent.id,
    factionId: agent.factionId,
    position: { ...task.target },
    data: { structureId: structure.id, structureType: task.structureType },
  });
  return structure;
}

function executeBuild(state: WorldState, agent: Agent, task: BuildTask): void {
  if (!samePosition(agent.position, task.target)) {
    moveAgent(state, agent, task.target);
    return;
  }
  let structure = task.structureId === undefined ? undefined : getStructure(state, task.structureId);
  if (structure === undefined) structure = startConstruction(state, agent, task);
  if (structure === undefined) return;
  if (structure.status === "active") {
    delete agent.task;
    agent.status = `${structure.type} complete`;
    return;
  }

  structure.progress += 1;
  agent.energy = Math.max(0, agent.energy - 2);
  agent.status = `building ${structure.type} ${structure.progress}/${structure.requiredProgress}`;
  if (structure.progress >= structure.requiredProgress) {
    structure.status = "active";
    structure.progress = structure.requiredProgress;
    delete agent.task;
    agent.status = `${structure.type} completed`;
    addEvent(state, {
      kind: "construction_completed",
      message: `${agent.name} completed a ${structure.type} for ${agent.factionId}.`,
      agentId: agent.id,
      factionId: agent.factionId,
      position: { ...structure.position },
      data: { structureId: structure.id, structureType: structure.type },
    });
  } else if (structure.progress === 1 || structure.progress % 4 === 0) {
    addEvent(state, {
      kind: "construction_progress",
      message: `${structure.type} construction reached ${structure.progress}/${structure.requiredProgress}.`,
      agentId: agent.id,
      factionId: agent.factionId,
      position: { ...structure.position },
      data: { structureId: structure.id, progress: structure.progress },
    });
  }
}

function canTransfer(agent: Agent, inventory: Inventory): boolean {
  return RESOURCE_KINDS.every((kind) => agent.inventory[kind] >= inventory[kind]);
}

function executeTrade(state: WorldState, agent: Agent, task: Extract<AgentTask, { type: "trade" }>): void {
  const target = getAgent(state, task.targetAgentId);
  if (target === undefined) {
    delete agent.task;
    agent.status = "trade target disappeared";
    return;
  }
  if (!samePosition(agent.position, target.position)) {
    moveAgent(state, agent, target.position);
    return;
  }
  if (!canTransfer(agent, task.offer) || !canTransfer(target, task.request)) {
    addEvent(state, {
      kind: "trade_failed",
      message: `${agent.name} and ${target.name} could not satisfy the proposed trade.`,
      agentId: agent.id,
      factionId: agent.factionId,
      position: { ...agent.position },
      data: { targetAgentId: target.id },
    });
    delete agent.task;
    agent.status = "trade failed";
    return;
  }
  for (const kind of RESOURCE_KINDS) {
    agent.inventory[kind] -= task.offer[kind];
    target.inventory[kind] += task.offer[kind];
    target.inventory[kind] -= task.request[kind];
    agent.inventory[kind] += task.request[kind];
  }
  delete agent.task;
  agent.status = `traded with ${target.name}`;
  addEvent(state, {
    kind: "trade_completed",
    message: `${agent.name} traded resources with ${target.name}.`,
    agentId: agent.id,
    factionId: agent.factionId,
    position: { ...agent.position },
    data: { targetAgentId: target.id, offer: task.offer, request: task.request },
  });
}

function executeTask(state: WorldState, agent: Agent): void {
  const task = agent.task;
  if (task === undefined) {
    agent.status = agent.autonomy ? "replanning" : "awaiting external command";
    agent.energy = Math.min(100, agent.energy + 1);
    return;
  }
  if (task.expiresAtTick !== undefined && state.tick > task.expiresAtTick) {
    delete agent.task;
    agent.status = "external task expired";
    return;
  }

  switch (task.type) {
    case "move":
      if (moveAgent(state, agent, task.target)) {
        delete agent.task;
        agent.status = "destination reached";
      }
      break;
    case "gather":
      executeGather(state, agent, task);
      break;
    case "build":
      executeBuild(state, agent, task);
      break;
    case "deposit":
      executeDeposit(state, agent, task);
      break;
    case "trade":
      executeTrade(state, agent, task);
      break;
  }
}

function regrowResources(state: WorldState, random: ReturnType<typeof createRandom>): void {
  for (const tile of state.tiles) {
    if (tile.resource === undefined || tile.resource.amount >= tile.resource.maxAmount) continue;
    if (random.next() < resourceRegrowthChance(state, tile)) tile.resource.amount += 1;
  }
}

export function simulate(
  previousState: WorldState,
  commands: readonly WorldCommand[] = [],
  config: SimulationConfig = DEFAULT_SIMULATION_CONFIG,
): SimulationResult {
  const state = structuredClone(previousState);
  ensureTileElevations(state);
  state.tick += 1;
  state.revision += 1;
  const random = createRandom(state.rngState);

  const receipts = commands.map((command) => applyCommand(state, command, config));

  const agents = [...state.agents].sort((a, b) => a.id.localeCompare(b.id));
  for (const agent of agents) {
    if (agent.task === undefined && agent.autonomy) {
      const plannedTask = autonomyTask(state, agent);
      if (plannedTask !== undefined) agent.task = plannedTask;
    }
    executeTask(state, agent);
  }

  if (state.tick % config.resourceRegrowthInterval === 0) regrowResources(state, random);
  state.rngState = random.state();
  state.events = state.events.slice(-config.eventLimit);
  state.processedCommandIds = state.processedCommandIds.slice(-config.commandHistoryLimit);
  return { state, receipts };
}
