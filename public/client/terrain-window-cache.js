function terrainTile(tile) {
  if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.y)) return null;
  return {
    x: tile.x,
    y: tile.y,
    terrain: tile.terrain,
    ...(Number.isFinite(tile.elevation) ? { elevation: tile.elevation } : {}),
  };
}

function terrainTileKey(tile) {
  return `${tile.x},${tile.y}`;
}

function normalizedTerrainTiles(tiles) {
  const byCell = new Map();
  if (!Array.isArray(tiles)) return [];
  for (const value of tiles) {
    const tile = terrainTile(value);
    if (tile) byCell.set(terrainTileKey(tile), tile);
  }
  return [...byCell.values()];
}

function mergeTerrainTiles(cachedTiles, liveTiles) {
  const cached = normalizedTerrainTiles(cachedTiles);
  const live = normalizedTerrainTiles(liveTiles);
  if (live.length === 0) return cached;

  // Cardinality alone is not enough to prove a live refresh is complete. A
  // same-sized payload can omit one cached cell while introducing a different
  // valid coordinate, which would still punch a visible hole if it replaced
  // the cache wholesale. Only treat live terrain as complete when it covers
  // every cached coordinate; supersets can still replace the cache normally.
  const liveKeys = new Set(live.map(terrainTileKey));
  const coversCached = cached.every((tile) => liveKeys.has(terrainTileKey(tile)));
  if (coversCached) return live;

  // Live and terrain windows are independent requests. A newer live response can
  // still be partial when one tile is malformed, duplicated, shifted, or a
  // payload is truncated. Judge completeness by coordinate coverage rather than
  // raw array length so an incomplete live set cannot replace the cache and
  // punch visible holes. Overlay every valid live tile while preserving cached
  // terrain for coordinates that were not present.
  const merged = new Map(cached.map((tile) => [terrainTileKey(tile), tile]));
  for (const tile of live) merged.set(terrainTileKey(tile), tile);
  return [...merged.values()];
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
    tiles: mergeTerrainTiles(cachedState.tiles, liveState.tiles),
  };
}

function liveTerrainChunk(chunk) {
  if (typeof chunk?.regionId !== "string" || !Array.isArray(chunk?.state?.tiles)) return null;
  const hexOrigin = chunk.hexOrigin;
  const axial = chunk.axial;
  if (
    !Number.isFinite(hexOrigin?.x) ||
    !Number.isFinite(hexOrigin?.y) ||
    !Number.isInteger(axial?.q) ||
    !Number.isInteger(axial?.r)
  ) {
    return null;
  }

  const tiles = normalizedTerrainTiles(chunk.state.tiles);
  if (tiles.length === 0) return null;
  return {
    ...chunk,
    state: {
      ...(Number.isFinite(chunk.state.width) ? { width: chunk.state.width } : {}),
      ...(Number.isFinite(chunk.state.height) ? { height: chunk.state.height } : {}),
      ...(Number.isFinite(chunk.state.tick) ? { tick: chunk.state.tick } : {}),
      ...(Number.isFinite(chunk.state.revision) ? { revision: chunk.state.revision } : {}),
      tiles,
    },
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
  const cachedRegionIds = new Set(
    terrainPayload.chunks
      .map((chunk) => chunk?.regionId)
      .filter((regionId) => typeof regionId === "string"),
  );
  const mergedChunks = terrainPayload.chunks.map((chunk) => {
    const live = liveByRegion.get(chunk?.regionId);
    if (!live) return chunk;
    return {
      ...chunk,
      state: mergeTerrainState(chunk.state, live.state),
    };
  });

  // A camera handoff can advance the radius-1 live window before the slower
  // radius-2 terrain refresh completes. Previously a newly entered region was
  // ignored until the terrain request caught up, creating a short-lived empty
  // macro hex. Admit only live-only chunks that carry complete placement
  // metadata and at least one valid terrain cell, and strip agents/structures
  // from their state so this cache stays terrain-only.
  for (const live of livePayload.chunks) {
    if (cachedRegionIds.has(live?.regionId)) continue;
    const terrain = liveTerrainChunk(live);
    if (!terrain) continue;
    mergedChunks.push(terrain);
    cachedRegionIds.add(terrain.regionId);
  }

  return {
    ...terrainPayload,
    chunks: mergedChunks,
  };
}
