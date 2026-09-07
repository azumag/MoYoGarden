function terrainTile(tile) {
  if (!tile || !Number.isFinite(tile.x) || !Number.isFinite(tile.y)) return null;
  return {
    x: tile.x,
    y: tile.y,
    terrain: tile.terrain,
    ...(Number.isFinite(tile.elevation) ? { elevation: tile.elevation } : {}),
  };
}

function mergeTerrainState(cachedState, liveState) {
  if (!cachedState || !Array.isArray(liveState?.tiles)) return cachedState;
  return {
    ...cachedState,
    ...(Number.isFinite(liveState.tick) ? { tick: liveState.tick } : {}),
    ...(Number.isFinite(liveState.revision) ? { revision: liveState.revision } : {}),
    tiles: liveState.tiles.map(terrainTile).filter(Boolean),
  };
}

export function mergeLiveTerrainWindow(terrainPayload, livePayload) {
  if (!Array.isArray(terrainPayload?.chunks) || !Array.isArray(livePayload?.chunks)) {
    return terrainPayload;
  }
  const liveByRegion = new Map(
    livePayload.chunks
      .filter((chunk) => typeof chunk?.regionId === "string")
      .map((chunk) => [chunk.regionId, chunk]),
  );
  return {
    ...terrainPayload,
    chunks: terrainPayload.chunks.map((chunk) => {
      const live = liveByRegion.get(chunk?.regionId);
      if (!live) return chunk;
      return {
        ...chunk,
        state: mergeTerrainState(chunk.state, live.state),
      };
    }),
  };
}
