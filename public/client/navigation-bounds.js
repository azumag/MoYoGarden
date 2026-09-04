export function resolveNavigationBounds(state, previewBounds = undefined, inset = 0.4) {
  const halfWidth = Math.max(2, state.width / 2 - inset);
  const halfHeight = Math.max(2, state.height / 2 - inset);
  const bounds = {
    minX: -halfWidth,
    maxX: halfWidth,
    minZ: -halfHeight,
    maxZ: halfHeight,
  };

  const minX = previewBounds?.min?.x;
  const maxX = previewBounds?.max?.x;
  const minZ = previewBounds?.min?.z;
  const maxZ = previewBounds?.max?.z;
  if (
    Number.isFinite(minX) &&
    Number.isFinite(maxX) &&
    Number.isFinite(minZ) &&
    Number.isFinite(maxZ)
  ) {
    bounds.minX = Math.min(bounds.minX, minX + inset);
    bounds.maxX = Math.max(bounds.maxX, maxX - inset);
    bounds.minZ = Math.min(bounds.minZ, minZ + inset);
    bounds.maxZ = Math.max(bounds.maxZ, maxZ - inset);
  }

  return bounds;
}
