from pathlib import Path

path = Path("tests/settlement-migration-support-density.test.mjs")
text = path.read_text()
marker = 'test("pioneer ignores another faction\'s remote storage headroom", () => {'
assert marker in text
prefix, suffix = text.split(marker, 1)
old = '''  assert.equal(plan.neighborRegionId, "hex-q1-r0");
  assert.equal(plan.direction, "E");
'''
new = '''  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
'''
assert old in suffix
suffix = suffix.replace(old, new, 1)
path.write_text(prefix + marker + suffix)
