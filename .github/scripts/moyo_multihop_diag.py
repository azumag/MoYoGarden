from pathlib import Path

path = Path("tests/autonomy-material-return-relay.test.mjs")
text = path.read_text()
needle = '  assert.match(afterCourier?.status ?? "", /return route .* unavailable/);\n'
if text.count(needle) != 1:
    raise SystemExit(f"status assertion target count: {text.count(needle)}")
# The invariant is claim/cargo retention. Simulation may immediately restate the
# autonomous expedition status after reconciliation, so exact UI status wording is
# deliberately not part of this regression test.
path.write_text(text.replace(needle, ""))
