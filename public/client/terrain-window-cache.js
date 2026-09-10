function terrainTile(tile) {
  if (!tile || !Number.isFinite(tile.x) || !Number.isFinite(tile.y)) return null;
  return {
    x: tile.x,
    y: tile.y,
    terrain: tile.terrain,
    ...(Number.isFinite(tile.elevation) ? { elevation: tile.elevation } : {}),
  };
}

function isStaleTerrainState(cachedState, liveState) {
  const cachedTick = Number.isFinite(cachedState?.tick) ? cachedState.tick : undefined;
  const liveTick = Number.isFinite(liveState?.tick) ? liveState.tick : undefined;
  if (cachedTick !== undefined && liveTick !== undefined) {
    if (liveTick < cachedTick) return true;
    if (liveTick > cachedTick) return false;
  }

  const cachedRevision = Number.isFinite(cachedState?.revision) ? cachedState.revision : undefined;
  const liveRevision = Number.isFinite(liveState?.revision) ? liveState.revision : undefined;
  return cachedRevision !== undefined
    && liveRevision !== undefined
    && liveRevision < cachedRevision;
}

function mergeTerrainState(cachedState, liveState) {
  if (!cachedState || !Array.isArray(liveState?.tiles)) return cachedState;
  // Terrain and live windows are fetched independently and can overlap near a
  // region handoff or refresh timeout. Keep the terrain cache monotonic so an
  // older live response cannot roll an already-rendered neighbor back to stale
  // terrain. Equal ticks still use revision as the deterministic tie-break.
  if (isStaleTerrainState(cachedState, liveState)) return cachedState;
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
