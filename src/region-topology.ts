import { hexGridCenter, hexGridRadius } from "./hex-grid.js";
import { TARGET_WORLD_HEIGHT, TARGET_WORLD_WIDTH } from "./world-scale.js";

export const HEX_DIRECTIONS = [
  "east",
  "northEast",
  "northWest",
  "west",
  "southWest",
  "southEast",
] as const;

export type HexDirection = (typeof HEX_DIRECTIONS)[number];

export interface HexCoordinate {
  q: number;
  r: number;
}

export interface HexWorldOrigin {
  x: number;
  y: number;
}

export interface HexFootprintSize {
  radius: number;
  width: number;
  height: number;
}

export interface RegionHexTopologyEntry {
  id: string;
  index: number;
  axial: HexCoordinate;
  physicalOrigin: HexWorldOrigin;
  hexOrigin: HexWorldOrigin;
  globalCellOrigin: HexWorldOrigin;
  ring: number;
  neighbors: Record<HexDirection, string | null>;
}

const HEX_STEPS: Readonly<Record<HexDirection, HexCoordinate>> = {
  east: { q: 1, r: 0 },
  northEast: { q: 1, r: -1 },
  northWest: { q: 0, r: -1 },
  west: { q: -1, r: 0 },
  southWest: { q: -1, r: 1 },
  southEast: { q: 0, r: 1 },
};

const AXIAL_REGION_ID_PATTERN = /^hex-q(-?(?:0|[1-9]\d*))-r(-?(?:0|[1-9]\d*))$/;

const LEGACY_REGION_AXIAL_ALIASES: ReadonlyMap<string, HexCoordinate> = new Map([
  ["garden-1", { q: 0, r: 0 }],
  ["garden-2", { q: 1, r: 0 }],
  ["garden-3", { q: 1, r: -1 }],
]);

const LEGACY_REGION_ID_BY_COORDINATE: ReadonlyMap<string, string> = new Map(
  [...LEGACY_REGION_AXIAL_ALIASES].map(([regionId, coordinate]) => [
    `${coordinate.q},${coordinate.r}`,
    regionId,
  ]),
);

function assertSafeAxialCoordinate(coordinate: HexCoordinate): void {
  if (!Number.isSafeInteger(coordinate.q) || !Number.isSafeInteger(coordinate.r)) {
    throw new RangeError("axial region coordinates must be safe integers");
  }
}

/**
 * Encode an axial coordinate as a canonical Durable Object routing name.
 * The format intentionally uses only the characters accepted by the current
 * public region-id validator so it can be adopted without widening API input.
 */
export function axialRegionId(coordinate: HexCoordinate): string {
  assertSafeAxialCoordinate(coordinate);
  return `hex-q${coordinate.q}-r${coordinate.r}`;
}

export function parseAxialRegionId(regionId: string): HexCoordinate | undefined {
  const match = AXIAL_REGION_ID_PATTERN.exec(regionId);
  if (match === null) return undefined;
  const q = Number(match[1]);
  const r = Number(match[2]);
  if (!Number.isSafeInteger(q) || !Number.isSafeInteger(r)) return undefined;
  const coordinate = { q, r };
  return axialRegionId(coordinate) === regionId ? coordinate : undefined;
}

function legacyRegionAxialCoordinate(regionId: string): HexCoordinate | undefined {
  const coordinate = LEGACY_REGION_AXIAL_ALIASES.get(regionId);
  return coordinate === undefined ? undefined : { ...coordinate };
}

/**
 * Resolve either a canonical axial region id or one of the persisted production
 * garden aliases into its logical axial identity. Unknown legacy names remain
 * unresolved so the compatibility layer cannot silently invent ownership.
 */
export function regionAxialCoordinate(regionId: string): HexCoordinate | undefined {
  return parseAxialRegionId(regionId) ?? legacyRegionAxialCoordinate(regionId);
}

function legacyRegionIdAtCoordinate(coordinate: HexCoordinate): string | undefined {
  return LEGACY_REGION_ID_BY_COORDINATE.get(coordinateKey(coordinate.q, coordinate.r));
}

export function hexNeighborCoordinate(
  coordinate: HexCoordinate,
  direction: HexDirection,
): HexCoordinate {
  assertSafeAxialCoordinate(coordinate);
  const step = HEX_STEPS[direction];
  const neighbor = { q: coordinate.q + step.q, r: coordinate.r + step.r };
  assertSafeAxialCoordinate(neighbor);
  return neighbor;
}

export function axialRegionNeighborId(
  regionId: string,
  direction: HexDirection,
): string | undefined {
  const canonicalCoordinate = parseAxialRegionId(regionId);
  const coordinate = canonicalCoordinate ?? legacyRegionAxialCoordinate(regionId);
  if (coordinate === undefined) return undefined;
  const neighbor = hexNeighborCoordinate(coordinate, direction);

  // Canonical dynamic ids stay canonical. Legacy production aliases retain
  // their existing names where the destination is one of garden-1/2/3, and
  // fall through to the canonical id outside that persisted compatibility set.
  return canonicalCoordinate !== undefined
    ? axialRegionId(neighbor)
    : legacyRegionIdAtCoordinate(neighbor) ?? axialRegionId(neighbor);
}

export function hexDistance(a: HexCoordinate, b: HexCoordinate = { q: 0, r: 0 }): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
}

export function regularHexFootprintSize(
  width = TARGET_WORLD_WIDTH,
  height = TARGET_WORLD_HEIGHT,
): HexFootprintSize {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : TARGET_WORLD_WIDTH;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : TARGET_WORLD_HEIGHT;
  const radius = Math.min(safeHeight / 2, safeWidth / Math.sqrt(3));
  return {
    radius,
    width: radius * Math.sqrt(3),
    height: radius * 2,
  };
}

/**
 * Return the persisted rectangular region origin used during the hex migration.
 * Keeping this explicit lets API clients distinguish storage ownership from the
 * logical/display hex placement until Durable Object ownership is migrated.
 */
export function projectPhysicalRegionOrigin(
  index: number,
  width = TARGET_WORLD_WIDTH,
): HexWorldOrigin {
  const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  const safeWidth = Number.isFinite(width) && width > 0 ? width : TARGET_WORLD_WIDTH;
  return { x: safeIndex * safeWidth, y: 0 };
}

/**
 * Project axial coordinates into the logical pointy-top hex display space.
 *
 * Physical ownership remains the persisted rectangular 40x24 layout, while the
 * display lattice uses a regular hex fitted inside that extent. This keeps the
 * six logical neighbor distances equal and prevents the rendered region from
 * being horizontally stretched.
 */
export function projectHexCoordinate(
  coordinate: HexCoordinate,
  width = TARGET_WORLD_WIDTH,
  height = TARGET_WORLD_HEIGHT,
): HexWorldOrigin {
  const footprint = regularHexFootprintSize(width, height);
  return {
    x: (coordinate.q + coordinate.r * 0.5) * footprint.width,
    y: coordinate.r * footprint.height * 0.75,
  };
}

/**
 * Project a macro-region axial coordinate into the shared axial cell lattice.
 *
 * Each 40x24 compatibility envelope contains a radius-11 active hex (397
 * cells). Adjacent radius-R hex clusters tile the infinite cell lattice with
 * basis vectors `(2R+1,-R)` and `(R,R+1)`, whose determinant is exactly the
 * number of active cells `3R(R+1)+1`. This gives every active local cell one
 * unique global axial address without changing persisted rectangular storage.
 *
 * The returned value is the global address of local storage cell `(0,0)`, so a
 * tile at local `(x,y)` is sampled at `origin + (x,y)`. Render `hexOrigin` and
 * persisted `physicalOrigin` deliberately remain separate coordinate spaces.
 */
export function projectRegionGlobalCellOrigin(
  coordinate: HexCoordinate,
  width = TARGET_WORLD_WIDTH,
  height = TARGET_WORLD_HEIGHT,
): HexWorldOrigin {
  assertSafeAxialCoordinate(coordinate);
  const safeWidth = Number.isSafeInteger(width) && width > 0 ? width : TARGET_WORLD_WIDTH;
  const safeHeight = Number.isSafeInteger(height) && height > 0 ? height : TARGET_WORLD_HEIGHT;
  const extent = { width: safeWidth, height: safeHeight };
  const center = hexGridCenter(extent);
  const radius = hexGridRadius(extent);
  const eastBasis = { x: radius * 2 + 1, y: -radius };
  const southEastBasis = { x: radius, y: radius + 1 };
  const regionCenter = {
    x: coordinate.q * eastBasis.x + coordinate.r * southEastBasis.x,
    y: coordinate.q * eastBasis.y + coordinate.r * southEastBasis.y,
  };
  if (!Number.isSafeInteger(regionCenter.x) || !Number.isSafeInteger(regionCenter.y)) {
    throw new RangeError("projected global cell coordinates must be safe integers");
  }
  return {
    x: regionCenter.x - center.x,
    y: regionCenter.y - center.y,
  };
}

export function regionGlobalCellOrigin(
  regionId: string,
  width = TARGET_WORLD_WIDTH,
  height = TARGET_WORLD_HEIGHT,
): HexWorldOrigin | undefined {
  const coordinate = regionAxialCoordinate(regionId);
  return coordinate === undefined
    ? undefined
    : projectRegionGlobalCellOrigin(coordinate, width, height);
}

function nextAvailableCoordinate(
  queue: HexCoordinate[],
  seen: Set<string>,
  occupied: Set<string>,
): HexCoordinate {
  while (true) {
    const coordinate = queue.shift();
    if (coordinate === undefined) {
      throw new Error("failed to allocate hex region coordinate");
    }

    for (const direction of HEX_DIRECTIONS) {
      const step = HEX_STEPS[direction];
      const next = { q: coordinate.q + step.q, r: coordinate.r + step.r };
      const key = coordinateKey(next.q, next.r);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }

    const key = coordinateKey(coordinate.q, coordinate.r);
    if (occupied.has(key)) continue;
    occupied.add(key);
    return coordinate;
  }
}

export function regionHexTopology(
  regionIds: readonly string[],
  width = TARGET_WORLD_WIDTH,
  height = TARGET_WORLD_HEIGHT,
): RegionHexTopologyEntry[] {
  if (regionIds.length === 0) return [];

  // garden-1/2/3 already own persisted production Durable Objects. Their
  // logical axial identities must therefore stay fixed even when a temporary
  // configuration exposes only a subset of those aliases. Unknown legacy ids
  // continue to use the historical ring-order allocation until the later
  // sparse-window migration replaces REGION_IDS enumeration altogether.
  const fixedCoordinates = regionIds.map((regionId) => regionAxialCoordinate(regionId));
  const occupied = new Set(
    fixedCoordinates.flatMap((coordinate) => coordinate === undefined
      ? []
      : [coordinateKey(coordinate.q, coordinate.r)]),
  );
  const queue: HexCoordinate[] = [{ q: 0, r: 0 }];
  const seen = new Set([coordinateKey(0, 0)]);
  const coordinates = fixedCoordinates.map((coordinate) =>
    coordinate ?? nextAvailableCoordinate(queue, seen, occupied)
  );

  const idByCoordinate = new Map<string, string>();
  coordinates.forEach((coordinate, index) => {
    const id = regionIds[index];
    if (id !== undefined) idByCoordinate.set(coordinateKey(coordinate.q, coordinate.r), id);
  });

  return coordinates.map((coordinate, index) => {
    const neighbors = Object.fromEntries(
      HEX_DIRECTIONS.map((direction) => {
        const step = HEX_STEPS[direction];
        const key = coordinateKey(coordinate.q + step.q, coordinate.r + step.r);
        return [direction, idByCoordinate.get(key) ?? null];
      }),
    ) as Record<HexDirection, string | null>;

    return {
      id: regionIds[index] ?? `region-${index}`,
      index,
      axial: coordinate,
      physicalOrigin: projectPhysicalRegionOrigin(index, width),
      hexOrigin: projectHexCoordinate(coordinate, width, height),
      globalCellOrigin: projectRegionGlobalCellOrigin(coordinate, width, height),
      ring: hexDistance(coordinate),
      neighbors,
    };
  });
}

function configuredRegionIdAtCoordinate(
  coordinate: HexCoordinate,
  indexById: ReadonlyMap<string, number>,
): string | undefined {
  const legacy = legacyRegionIdAtCoordinate(coordinate);
  const canonical = axialRegionId(coordinate);
  let selected: string | undefined;
  let selectedIndex = Number.POSITIVE_INFINITY;
  for (const candidate of legacy === undefined ? [canonical] : [legacy, canonical]) {
    const index = indexById.get(candidate);
    if (index !== undefined && index < selectedIndex) {
      selected = candidate;
      selectedIndex = index;
    }
  }
  return selected;
}

/**
 * Resolve one configured neighbor without rebuilding the whole region topology.
 * Axial-aware ids take the direct coordinate path; unresolved historical ids
 * retain the old ring-allocation fallback until REGION_IDS compatibility ends.
 */
export function configuredRegionNeighborId(
  regionIds: readonly string[],
  sourceRegionId: string,
  direction: HexDirection,
  width = TARGET_WORLD_WIDTH,
  height = TARGET_WORLD_HEIGHT,
): string | undefined {
  const source = regionAxialCoordinate(sourceRegionId);
  if (source !== undefined) {
    const indexById = new Map(regionIds.map((regionId, index) => [regionId, index] as const));
    if (!indexById.has(sourceRegionId)) return undefined;
    return configuredRegionIdAtCoordinate(hexNeighborCoordinate(source, direction), indexById);
  }

  const sourceEntry = regionHexTopology(regionIds, width, height)
    .find((entry) => entry.id === sourceRegionId);
  return sourceEntry?.neighbors[direction] ?? undefined;
}

/**
 * Build only the configured topology entries inside a bounded axial window.
 * Resolved legacy aliases and canonical IDs can be addressed directly from
 * their coordinates, so normal window requests avoid constructing the full
 * ring topology. Unknown historical IDs retain the old full-topology fallback
 * until REGION_IDS compatibility is removed in a later migration phase.
 */
export function regionHexWindow(
  regionIds: readonly string[],
  centerRegionId: string,
  radius = 1,
  width = TARGET_WORLD_WIDTH,
  height = TARGET_WORLD_HEIGHT,
): RegionHexTopologyEntry[] {
  if (regionIds.length === 0) return [];
  const indexById = new Map(regionIds.map((regionId, index) => [regionId, index] as const));
  if (!indexById.has(centerRegionId)) return [];
  const safeRadius = Number.isFinite(radius)
    ? Math.max(0, Math.min(4, Math.floor(radius)))
    : 1;

  if (regionIds.some((regionId) => regionAxialCoordinate(regionId) === undefined)) {
    const topology = regionHexTopology(regionIds, width, height);
    const centerEntry = topology.find((entry) => entry.id === centerRegionId);
    return centerEntry === undefined
      ? []
      : topology.filter((entry) => hexDistance(entry.axial, centerEntry.axial) <= safeRadius);
  }

  const center = regionAxialCoordinate(centerRegionId);
  if (center === undefined) return [];
  const centerKey = coordinateKey(center.q, center.r);
  const entries: RegionHexTopologyEntry[] = [];
  for (let q = center.q - safeRadius; q <= center.q + safeRadius; q += 1) {
    for (let r = center.r - safeRadius; r <= center.r + safeRadius; r += 1) {
      const coordinate = { q, r };
      if (hexDistance(coordinate, center) > safeRadius) continue;
      const id = coordinateKey(q, r) === centerKey
        ? centerRegionId
        : configuredRegionIdAtCoordinate(coordinate, indexById);
      if (id === undefined) continue;
      const index = indexById.get(id);
      if (index === undefined) continue;
      const neighbors = Object.fromEntries(
        HEX_DIRECTIONS.map((direction) => [
          direction,
          configuredRegionIdAtCoordinate(hexNeighborCoordinate(coordinate, direction), indexById) ?? null,
        ]),
      ) as Record<HexDirection, string | null>;
      entries.push({
        id,
        index,
        axial: coordinate,
        physicalOrigin: projectPhysicalRegionOrigin(index, width),
        hexOrigin: projectHexCoordinate(coordinate, width, height),
        globalCellOrigin: projectRegionGlobalCellOrigin(coordinate, width, height),
        ring: hexDistance(coordinate),
        neighbors,
      });
    }
  }
  return entries.sort((a, b) => a.index - b.index);
}

function coordinateKey(q: number, r: number): string {
  return `${q},${r}`;
}
