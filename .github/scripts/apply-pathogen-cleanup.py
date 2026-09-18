from pathlib import Path

source = Path("src/pathogen.ts")
text = source.read_text()
old = "  const keys = new Set([...advectedReservoir.keys(), ...shedding.keys()]);\n"
new = (
    "  const keys = new Set([...advectedReservoir.keys(), ...shedding.keys()]);\n"
    "  // Keep explicitly persisted zero-valued reservoirs in the mutation pass once\n"
    "  // so the optional field can be deleted. pathogenReservoirIndex intentionally\n"
    "  // omits zero burden from the hot index, but quiescent detection treats an\n"
    "  // explicit field as cleanup work; without this bridge a stored zero would\n"
    "  // survive forever and permanently defeat the quiescent fast path.\n"
    "  for (const tile of tiles) {\n"
    "    if ((tile as PathogenTile).pathogenReservoir !== undefined) {\n"
    "      keys.add(positionKey(tile));\n"
    "    }\n"
    "  }\n"
)
if old not in text:
    raise SystemExit("pathogen source anchor not found")
source.write_text(text.replace(old, new, 1))

test = Path("tests/pathogen-quiescent-fast-path.test.mjs")
text = test.read_text()
old = (
    "  assert.equal(\n"
    "    pathogenStateIsQuiescent(state),\n"
    "    false,\n"
    "    \"an explicitly stored active reservoir gets one normal pass so it can be cleaned\",\n"
    "  );\n"
    "  delete active.pathogenReservoir;\n"
    "\n"
    "  target.pathogenLoad = 0;\n"
)
new = (
    "  assert.equal(\n"
    "    pathogenStateIsQuiescent(state),\n"
    "    false,\n"
    "    \"an explicitly stored active reservoir gets one normal pass so it can be cleaned\",\n"
    "  );\n"
    "  assert.ok(applyPathogenSteps(state, 1) > 0);\n"
    "  assert.equal(\n"
    "    active.pathogenReservoir,\n"
    "    undefined,\n"
    "    \"the cleanup pass must delete an explicit zero reservoir instead of leaving the region hot\",\n"
    "  );\n"
    "  assert.equal(pathogenStateIsQuiescent(state), true);\n"
    "\n"
    "  target.pathogenLoad = 0;\n"
)
if old not in text:
    raise SystemExit("pathogen test anchor not found")
test.write_text(text.replace(old, new, 1))
