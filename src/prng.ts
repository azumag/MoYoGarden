export interface RandomSource {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  state(): number;
}

export function createRandom(seed: number): RandomSource {
  let current = seed >>> 0;
  if (current === 0) current = 0x6d2b79f5;

  const next = (): number => {
    current ^= current << 13;
    current ^= current >>> 17;
    current ^= current << 5;
    current >>>= 0;
    return current / 0x1_0000_0000;
  };

  return {
    next,
    int(minInclusive: number, maxInclusive: number): number {
      if (maxInclusive < minInclusive) {
        throw new Error("maxInclusive must be >= minInclusive");
      }
      return Math.floor(next() * (maxInclusive - minInclusive + 1)) + minInclusive;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("cannot pick from an empty list");
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error("random pick failed");
      return item;
    },
    state(): number {
      return current >>> 0;
    },
  };
}
