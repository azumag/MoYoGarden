export function createDemoState() {
  const width = 24;
  const height = 16;
  const tiles = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const river = Math.abs(x - 12 - Math.sin(y * 0.55) * 2) < 1;
      const terrain = edge || river
        ? "water"
        : (x * 13 + y * 7) % 17 < 3
          ? "forest"
          : (x * 5 + y * 11) % 23 < 4 ? "hill" : "plain";
      let resource;
      if (terrain === "forest" && (x + y) % 2 === 0) {
        resource = { kind: "wood", amount: 14, maxAmount: 20 };
      } else if (terrain === "hill" && (x + y) % 2 === 0) {
        resource = { kind: "stone", amount: 12, maxAmount: 18 };
      } else if (terrain === "plain" && (x * 3 + y) % 19 === 0) {
        resource = { kind: "food", amount: 9, maxAmount: 14 };
      }
      tiles.push({ x, y, terrain, ...(resource ? { resource } : {}) });
    }
  }

  const factions = [
    { id: "ember", name: "Ember Union", color: "#ef6c45", resources: { wood: 34, stone: 18, food: 21 }, credits: 0 },
    { id: "azure", name: "Azure Compact", color: "#4f86e8", resources: { wood: 29, stone: 25, food: 17 }, credits: 0 },
    { id: "verdant", name: "Verdant League", color: "#53a968", resources: { wood: 42, stone: 14, food: 31 }, credits: 0 },
  ];
  const definitions = [["ember", 4, 4], ["azure", 19, 4], ["verdant", 6, 12]];
  const roles = ["builder", "woodcutter", "miner", "forager"];
  const agents = [];
  for (const [factionId, startX, startY] of definitions) {
    for (let index = 0; index < 4; index += 1) {
      agents.push({
        id: `agent-${factionId}-${roles[index]}`,
        name: `${factionId[0].toUpperCase()}${roles[index].slice(0, 4)}`,
        factionId,
        role: roles[index],
        position: { x: startX + index % 2, y: startY + Math.floor(index / 2) },
        hp: 100,
        energy: 100,
        capacity: 12,
        inventory: { wood: index, stone: 0, food: 1 },
        autonomy: true,
        goal: "地域資源を集めて自律集落を拡張する",
        status: index === 0 ? "planning construction" : "gathering resources",
      });
    }
  }

  const structures = definitions.flatMap(([factionId, x, y], index) => [
    {
      id: `${factionId}-camp`, factionId, type: "camp",
      position: { x: x + 1, y: y + 1 }, status: "active",
      progress: 6, requiredProgress: 6, storage: { wood: 8, stone: 4, food: 3 },
    },
    ...(index === 0 ? [
      {
        id: "ember-market", factionId, type: "market",
        position: { x: x + 3, y: y + 1 }, status: "active",
        progress: 11, requiredProgress: 11, storage: { wood: 4, stone: 2, food: 2 },
      },
      {
        id: "ember-workshop", factionId, type: "workshop",
        position: { x: x + 4, y: y + 3 }, status: "active",
        progress: 12, requiredProgress: 12, storage: { wood: 3, stone: 4, food: 1 },
      },
    ] : []),
  ]);

  return {
    schemaVersion: 1,
    worldId: "demo-world",
    regionId: "offline-demo",
    revision: 1,
    tick: 84,
    seed: 424242,
    rngState: 1,
    width,
    height,
    tiles,
    factions,
    agents,
    structures,
    events: [
      { id: "e1", tick: 84, kind: "construction_completed", message: "Ember Union が市場を完成させた" },
      { id: "e2", tick: 79, kind: "resources_deposited", message: "Verdant League が食料を共同備蓄へ搬入した" },
      { id: "e3", tick: 72, kind: "world_started", message: "3勢力のBOTが開拓を開始した" },
    ],
    processedCommandIds: [],
  };
}
