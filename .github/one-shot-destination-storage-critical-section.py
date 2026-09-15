from pathlib import Path

source = Path("src/autonomy-region.ts")
text = source.read_text()

reserve_start = text.index("    const now = Date.now();", text.index("  private async reserveDestinationStorage"))
reserve_end = text.index("  private async releaseDestinationStorage", reserve_start)
reserve = text[reserve_start:reserve_end]
reserve = '''    const claimId = body.claimId;
    const sourceRegionId = body.sourceRegionId;
    const factionId = body.factionId;
    const requestedAmount = body.amount;
''' + reserve
reserve = reserve.replace(
    "this.autonomyState.storage.transaction(async (transaction) => {",
    "this.autonomyState.blockConcurrencyWhile(async () => {",
)
reserve = reserve.replace("transaction.get<unknown>", "this.autonomyState.storage.get<unknown>")
reserve = reserve.replace("transaction.put(", "this.autonomyState.storage.put(")
reserve = reserve.replace("body.claimId", "claimId")
reserve = reserve.replace("body.sourceRegionId", "sourceRegionId")
reserve = reserve.replace("body.factionId", "factionId")
reserve = reserve.replace("body.amount", "requestedAmount")
reserve = reserve.replace(
    "const result = await this.autonomyState.blockConcurrencyWhile(async () => {",
    '''// Reservation admission is rare (only remote-sink expedition launch), so a
    // short Durable Object critical section is preferable to a read/modify/write
    // race across concurrent source regions. Keep only storage I/O and arithmetic
    // inside the gate; no network fetch occurs while concurrency is blocked.
    const result = await this.autonomyState.blockConcurrencyWhile(async () => {''',
    1,
)
text = text[:reserve_start] + reserve + text[reserve_end:]

release_fn_start = text.index("  private async releaseDestinationStorage")
release_start = text.index("    const now = Date.now();", release_fn_start)
release_end = text.index("    return new Response", release_start)
release = text[release_start:release_end]
release = '''    const claimId = body.claimId;
    const sourceRegionId = body.sourceRegionId;
''' + release
release = release.replace(
    "this.autonomyState.storage.transaction(async (transaction) => {",
    "this.autonomyState.blockConcurrencyWhile(async () => {",
)
release = release.replace("transaction.get<unknown>", "this.autonomyState.storage.get<unknown>")
release = release.replace("transaction.put(", "this.autonomyState.storage.put(")
release = release.replace("body.claimId", "claimId")
release = release.replace("body.sourceRegionId", "sourceRegionId")
text = text[:release_start] + release + text[release_end:]
source.write_text(text)

test_path = Path("tests/autonomous-concurrent-travel-do.test.mjs")
tests = test_path.read_text()
old = '''  blockConcurrencyWhile(callback) {
    const result = Promise.resolve().then(callback);
    this.ready = result.catch(() => {});
    return result;
  }
'''
new = '''  blockConcurrencyWhile(callback) {
    const result = this.ready.then(callback);
    this.ready = result.catch(() => {});
    return result;
  }
'''
assert old in tests, "MemoryState blockConcurrencyWhile anchor not found"
tests = tests.replace(old, new, 1)
test_path.write_text(tests)
