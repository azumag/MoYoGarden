from pathlib import Path

src_path = Path("src/settlement-migration.ts")
src = src_path.read_text()
old = '''  if (storageHeadroom <= 0) return false;\n  return faction.resources.food > 0 || state.tiles.some((tile) =>\n'''
new = '''  if (storageHeadroom <= 0) return false;\n  const storedFoodAvailable = activeStructures.some((structure) => structure.storage.food > 0);\n  return faction.resources.food > 0 || storedFoodAvailable || state.tiles.some((tile) =>\n'''
count = src.count(old)
assert count == 1, f"expected one family admission return, got {count}"
src_path.write_text(src.replace(old, new, 1))

test_path = Path("tests/settlement-family-follow.test.mjs")
test_src = test_path.read_text()
old_test = '''  faction.resources = { wood: 0, stone: 0, food: 0 };\n  assert.equal(settlementFamilyAdmissionReady(state, faction.id), false);\n  const foodTile = state.tiles.find((tile) => isHexGridCell(state, tile) && tile.terrain !== "water");\n'''
new_test = '''  faction.resources = { wood: 0, stone: 0, food: 0 };\n  assert.equal(settlementFamilyAdmissionReady(state, faction.id), false);\n  state.structures[0].storage.food = 2;\n  assert.equal(\n    settlementFamilyAdmissionReady(state, faction.id),\n    true,\n    "food already stored in an active faction structure should support family admission",\n  );\n  state.structures[0].storage.food = 0;\n  const foodTile = state.tiles.find((tile) => isHexGridCell(state, tile) && tile.terrain !== "water");\n'''
count = test_src.count(old_test)
assert count == 1, f"expected one family admission fixture, got {count}"
test_path.write_text(test_src.replace(old_test, new_test, 1))
