// Integer, midpoint-spaced intervention slots; independent of engine RNG/time.
export const MIGRATION_MODES = Object.freeze([
  "constant", "in-phase", "out-of-phase", "constant-asymmetric", "out-of-phase-asymmetric",
]);

export function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return parsed;
}

export function migrationSchedule(options = {}) {
  const mode = options.mode ?? "constant";
  if (!MIGRATION_MODES.includes(mode)) throw new Error("unknown migration mode");
  const period = integer(options.period ?? 8640, "period", 16, 1_000_000);
  const migrants = integer(options.migrants ?? 4, "migrants", 4, 64);
  if (period % 4 || migrants % 4 || migrants > period / 4) {
    throw new Error("period/migrants must be multiples of four, with migrants <= period/4");
  }
  const asymmetric = mode.endsWith("-asymmetric");
  const quotas = asymmetric ? [migrants * 3 / 4, migrants / 4] : [migrants / 2, migrants / 2];
  return { mode, period, migrants, quotas };
}

export function migrationSlotsAt(schedule, tick) {
  integer(tick, "tick");
  const { period, quotas, mode } = schedule;
  const width = mode.startsWith("constant") ? period : period / 4;
  return quotas.map((quota, direction) => {
    const shift = mode.startsWith("out-of-phase") && direction === 1 ? period / 2 : 0;
    const phase = ((tick - 1) % period - shift + period) % period;
    if (phase >= width) return 0;
    // Midpoints leave a tail for travel; integrated directional budgets are exact.
    return Math.floor(((phase + 1) * quota + width / 2) / width)
      - Math.floor((phase * quota + width / 2) / width);
  });
}

// A count-matched gate, NOT evidence of a biological selection effect.
export function compareMigrationRuns(summaries) {
  const groups = [["constant", "in-phase", "out-of-phase"],
    ["constant-asymmetric", "out-of-phase-asymmetric"]];
  return groups.map((modes) => {
    const runs = modes.map((mode) => summaries.find((s) => s.run.schedule.mode === mode));
    const present = runs.every(Boolean);
    const complete = present && runs.every((s) => s.run.completed);
    const sameSetup = present && runs.every((s) => s.initialStateHash === runs[0].initialStateHash
      && s.run.seed === runs[0].run.seed && s.run.engineHash === runs[0].run.engineHash
      && s.run.implementationHash === runs[0].run.implementationHash
      && s.run.scheduleTicks === runs[0].run.scheduleTicks
      && s.run.schedule.period === runs[0].run.schedule.period
      && s.run.schedule.migrants === runs[0].run.schedule.migrants
      && s.run.maxTravelTicks === runs[0].run.maxTravelTicks);
    const realized = present && runs.every((s) => s.migration.every((m, d) =>
      m.scheduled > 0 && m.arrived === m.scheduled && m.arrived === runs[0].migration[d].arrived
      && m.failed === 0 && m.skipped === 0 && m.inFlight === 0));
    return { modes, countMatched: Boolean(complete && sameSetup && realized),
      reason: !present ? "missing-arm" : !complete ? "incomplete-run"
        : !sameSetup ? "different-setup" : !realized ? "unmatched-or-unfulfilled-migration" : null };
  });
}
