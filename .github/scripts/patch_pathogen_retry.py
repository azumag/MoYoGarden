from pathlib import Path
import re

source_path = Path("src/pathogen-region.ts")
source = source_path.read_text()

anchor = 'export const PATHOGEN_EDGE_READ_TIMEOUT_MS = 5_000;\n'
insertion = '''export const PATHOGEN_EDGE_READ_TIMEOUT_MS = 5_000;
export const PATHOGEN_RESERVOIR_TRANSFER_ATTEMPT_BUDGET = 6;

/**
 * Bound cross-DO reservoir retry work per Alarm while rotating the starting
 * point by simulation tick. Mass remains owned by the durable source journal
 * until acknowledgement, so deferring a route changes latency rather than
 * conservation. The attempted set is shared by both flush phases in one Alarm,
 * preventing old failed records from consuming the budget twice.
 */
export function selectPathogenReservoirRetryIds(
  records: readonly { transferId: string }[],
  attemptedTransferIds: ReadonlySet<string>,
  tick: number,
  limit = PATHOGEN_RESERVOIR_TRANSFER_ATTEMPT_BUDGET,
): string[] {
  const budget = Math.max(0, Math.floor(limit) - attemptedTransferIds.size);
  if (budget <= 0) return [];
  const pending = records
    .filter((record) => !attemptedTransferIds.has(record.transferId))
    .map((record) => record.transferId)
    .sort((a, b) => a.localeCompare(b));
  if (pending.length <= budget) return pending;
  const normalizedTick = Number.isSafeInteger(tick) ? Math.max(0, tick) : 0;
  const offset = ((normalizedTick % pending.length) * budget) % pending.length;
  return Array.from(
    { length: budget },
    (_entry, index) => pending[(offset + index) % pending.length]!,
  );
}

export async function deliverPathogenReservoirRetryBatch<T extends { transferId: string }>(
  records: readonly T[],
  attemptedTransferIds: Set<string>,
  tick: number,
  deliver: (record: T) => Promise<boolean>,
  limit = PATHOGEN_RESERVOIR_TRANSFER_ATTEMPT_BUDGET,
): Promise<Set<string>> {
  const selectedIds = new Set(
    selectPathogenReservoirRetryIds(records, attemptedTransferIds, tick, limit),
  );
  if (selectedIds.size === 0) return new Set();
  const selected = records.filter((record) => selectedIds.has(record.transferId));
  for (const record of selected) attemptedTransferIds.add(record.transferId);
  const outcomes = await Promise.all(selected.map(async (record) =>
    await deliver(record) ? record.transferId : undefined
  ));
  return new Set(outcomes.filter((value): value is string => value !== undefined));
}
'''
if anchor not in source:
    raise SystemExit("timeout constant anchor not found")
source = source.replace(anchor, insertion, 1)

pattern = re.compile(
    r'  private async flushOutgoingPathogenReservoir\(\): Promise<void> \{.*?\n  \}\n\n  private async acceptIncomingPathogenReservoir',
    re.S,
)
replacement = '''  private async flushOutgoingPathogenReservoir(
    attemptedTransferIds: Set<string>,
  ): Promise<void> {
    const records = await this.outgoingPathogenReservoirTransfers();
    if (records.length === 0) return;
    const acknowledged = await deliverPathogenReservoirRetryBatch(
      records,
      attemptedTransferIds,
      runtimeAccess(this).runtime.snapshot().tick,
      async (record) => {
        try {
          const response = await withPathogenEdgeDeadline((signal) =>
            this.pathogenStub(record.toRegionId).fetch(new Request(
              `https://moyo.internal${INTERNAL_PATHOGEN_RESERVOIR_TRANSFER_PATH}`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-moyo-region-internal": record.toRegionId,
                },
                body: JSON.stringify(record),
                signal,
              },
            )),
          );
          return response.ok;
        } catch (error) {
          console.debug(
            "MoYoGarden pathogen reservoir transfer unavailable",
            record.toRegionId,
            record.transferId,
            error,
          );
          return false;
        }
      },
    );
    if (acknowledged.size === 0) return;
    const current = await this.outgoingPathogenReservoirTransfers();
    await this.pathogenState.storage.put(
      OUTGOING_PATHOGEN_RESERVOIR_KEY,
      current.filter((record) => !acknowledged.has(record.transferId)),
    );
  }

  private async acceptIncomingPathogenReservoir'''
source, count = pattern.subn(replacement, source, count=1)
if count != 1:
    raise SystemExit(f"flush function replacement count={count}")

old = '''    await this.flushOutgoingPathogenReservoir();
    const workingState = access.runtime.snapshot();'''
new = '''    const attemptedPathogenReservoirTransfers = new Set<string>();
    await this.flushOutgoingPathogenReservoir(attemptedPathogenReservoirTransfers);
    const workingState = access.runtime.snapshot();'''
if old not in source:
    raise SystemExit("first flush call anchor not found")
source = source.replace(old, new, 1)

old = '''    await this.flushOutgoingPathogenReservoir();
  }
}'''
new = '''    await this.flushOutgoingPathogenReservoir(attemptedPathogenReservoirTransfers);
  }
}'''
if old not in source:
    raise SystemExit("second flush call anchor not found")
source = source.replace(old, new, 1)
source_path.write_text(source)

test_path = Path("tests/pathogen-reservoir-transfer-do.test.mjs")
tests = test_path.read_text()
old_import = 'import { RegionDurableObject } from "../dist-ts/src/pathogen-region.js";'
new_import = '''import {
  deliverPathogenReservoirRetryBatch,
  RegionDurableObject,
  selectPathogenReservoirRetryIds,
} from "../dist-ts/src/pathogen-region.js";'''
if old_import not in tests:
    raise SystemExit("test import anchor not found")
tests = tests.replace(old_import, new_import, 1)

regression = r'''

test("pathogen reservoir retries stay bounded per alarm and rotate fairly", async () => {
  const records = Array.from({ length: 10 }, (_entry, index) => ({
    transferId: `transfer-${index.toString().padStart(2, "0")}`,
  }));
  const attempted = new Set();
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delivery = deliverPathogenReservoirRetryBatch(
    records,
    attempted,
    0,
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 6, "one alarm should never fan out more than six retry subrequests");
  assert.equal(attempted.size, 6);
  release();
  const acknowledged = await delivery;
  assert.equal(acknowledged.size, 6);
  assert.deepEqual(
    selectPathogenReservoirRetryIds(records, attempted, 0),
    [],
    "the second flush phase must share the same per-alarm budget",
  );

  const nextAlarm = selectPathogenReservoirRetryIds(records, new Set(), 1);
  assert.equal(nextAlarm.length, 6);
  assert.ok(
    nextAlarm.some((transferId) => !acknowledged.has(transferId)),
    "a later tick should rotate retry priority instead of starving deferred routes",
  );
});
'''
if "pathogen reservoir retries stay bounded per alarm and rotate fairly" in tests:
    raise SystemExit("regression test already present")
tests += regression
test_path.write_text(tests)
