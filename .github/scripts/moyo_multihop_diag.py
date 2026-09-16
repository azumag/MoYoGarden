from pathlib import Path

path = Path("tests/autonomy-material-return-relay.test.mjs")
text = path.read_text()
needle = '  assert.equal(deposited, true, "cargo should cross both ownership handoffs and deposit at the origin storehouse");'
if text.count(needle) != 1:
    raise SystemExit(f"diagnostic target count: {text.count(needle)}")
diagnostic = '''  if (!deposited) {
    console.error(JSON.stringify({
      first: first.object.runtime.snapshot(),
      relay: relay.object.runtime.snapshot(),
      origin: origin.object.runtime.snapshot(),
      firstStorage: [...first.state.storage.values.entries()],
      relayStorage: [...relay.state.storage.values.entries()],
      originStorage: [...origin.state.storage.values.entries()],
    }, null, 2));
  }
'''
path.write_text(text.replace(needle, diagnostic + needle))
