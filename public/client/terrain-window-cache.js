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

function sameTerrainValue(left, right) {
  return left.terrain === right.terrain
    && (left.elevation ?? null) === (right.elevation ?? null);
}

function reuseCachedTerrainTiles(cachedTiles, nextTiles) {
  if (!Array.isArray(cachedTiles) || cachedTiles.length !== nextTiles.length) return nextTiles;
  const cached = normalizedTerrainTiles(cachedTiles);
  // Do not preserve malformed/duplicated cached arrays merely to keep identity;
  // normalization is still part of the cache's defensive contract.
  if (cached.length !== cachedTiles.length) return nextTiles;
  const nextByCell = new Map(nextTiles.map((tile) => [terrainTileKey(tile), tile]));
  if (nextByCell.size !== cached.length) return nextTiles;
  for (const tile of cached) {
    const next = nextByCell.get(terrainTileKey(tile));
    if (!next || !sameTerrainValue(tile, next)) return nextTiles;
  }
  return cachedTiles;
}

function mergeTerrainTiles(cachedTiles, liveTiles) {
  const cached = normalizedTerrainTiles(cachedTiles);
  const live = normalizedTerrainTiles(liveTiles);
  if (live.length === 0) return reuseCachedTerrainTiles(cachedTiles, cached);

  // Cardinality alone is not enough to prove a live refresh is complete. A
  // same-sized payload can omit one cached cell while introducing a different
  // valid coordinate, which would still punch a visible hole if it replaced
  // the cache wholesale. Only treat live terrain as complete when it covers
  // every cached coordinate; supersets can still replace the cache normally.
  const liveKeys = new Set(live.map(terrainTileKey));
  const coversCached = cached.every((tile) => liveKeys.has(terrainTileKey(tile)));
  if (coversCached) return reuseCachedTerrainTiles(cachedTiles, live);

  // Live and terrain windows are independent requests. A newer live response can
  // still be partial when one tile is malformed, duplicated, shifted, or a
  // payload is truncated. Judge completeness by coordinate coverage rather than
  // raw array length so an incomplete live set cannot replace the cache and
  // punch visible holes. Overlay every valid live tile while preserving cached
  // terrain for coordinates that were not present.
  const merged = new Map(cached.map((tile) => [terrainTileKey(tile), tile]));
  for (const tile of live) merged.set(terrainTileKey(tile), tile);
  return reuseCachedTerrainTiles(cachedTiles, [...merged.values()]);
}

function isStaleTerrainState(cachedState, liveState) {
  const cachedTick = Number.isFinite(cachedState?.tick) ? cachedState.tick : undefined;
  const liveTick = Number.isFinite(liveState?.tick) ? liveState.tick : undefined;
  if (cachedTick !== undefined) {
    // Once the cache has a monotonic tick, an unversioned live payload cannot
    // prove that it is newer. Fail closed instead of letting a partial/malformed
    // response overwrite terrain that is already known to be fresh.
    if (liveTick === undefined) return true;
    if (liveTick < cachedTick) return true;
    if (liveTick > cachedTick) return false;
  }

  const cachedRevision = Number.isFinite(cachedState?.revision) ? cachedState.revision : undefined;
  const liveRevision = Number.isFinite(liveState?.revision) ? liveState.revision : undefined;
  if (cachedRevision === undefined) return false;
  // Equal-tick refreshes use revision as the deterministic tie-break. If the
  // cached state has a revision but the live response omits it, accepting that
  // response would make the monotonicity check fail open.
  if (liveRevision === undefined) return true;
  return liveRevision < cachedRevision;
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

export function terrainWindowTilesChanged(previousPayload, nextPayload, centerRegionId) {
  if (previousPayload === nextPayload) return false;
  if (!Array.isArray(previousPayload?.chunks) || !Array.isArray(nextPayload?.chunks)) return true;
  const previousByRegion = new Map(
    previousPayload.chunks
      .filter((chunk) => typeof chunk?.regionId === "string")
      .map((chunk) => [chunk.regionId, chunk]),
  );
  const nextVisible = nextPayload.chunks.filter((chunk) => chunk?.regionId !== centerRegionId);
  const previousVisibleCount = previousPayload.chunks.filter((chunk) => chunk?.regionId !== centerRegionId).length;
  if (nextVisible.length !== previousVisibleCount) return true;
  return nextVisible.some((chunk) => {
    const previous = previousByRegion.get(chunk?.regionId);
    return !previous || previous.state?.tiles !== chunk?.state?.tiles;
  });
}
