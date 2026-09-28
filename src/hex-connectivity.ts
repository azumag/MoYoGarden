import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  isHexGridCell,
  type HexGridPosition,
} from "./hex-grid.js";
import type { WorldState } from "./protocol.js";

function positionKey(position: HexGridPosition): string {
  return `${position.x},${position.y}`;
}

export function passableHexComponentByPosition(
  state: Pick<WorldState, "width" | "height" | "tiles">,
): Map<string, number> {
  const tileByPosition = new Map(
    state.tiles.map((tile) => [`${tile.x},${tile.y}`, tile] as const),
  );
  const passable = state.tiles
    .filter((tile) => isHexGridCell(state, tile) && tile.terrain !== "water")
    .map((tile) => ({ x: tile.x, y: tile.y }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const result = new Map<string, number>();
  const visited = new Set<string>();

  for (const start of passable) {
    const startKey = positionKey(start);
    if (visited.has(startKey)) continue;

    const queue: HexGridPosition[] = [{ ...start }];
    const component: HexGridPosition[] = [];
    let componentId = start.y * state.width + start.x;
    visited.add(startKey);

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      if (current === undefined) break;
      component.push(current);
      componentId = Math.min(componentId, current.y * state.width + current.x);

      for (const direction of HEX_GRID_DIRECTIONS) {
        const step = HEX_GRID_DIRECTION_STEPS[direction];
        const next = { x: current.x + step.x, y: current.y + step.y };
        const nextKey = positionKey(next);
        if (visited.has(nextKey) || !isHexGridCell(state, next)) continue;
        const tile = tileByPosition.get(nextKey);
        if (tile === undefined || tile.terrain === "water") continue;
        visited.add(nextKey);
        queue.push(next);
      }
    }

    for (const position of component) {
      result.set(positionKey(position), componentId);
    }
  }

  return result;
}
