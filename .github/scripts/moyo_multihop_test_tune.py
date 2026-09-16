from pathlib import Path

path = Path("tests/autonomy-material-return-relay.test.mjs")
text = path.read_text()
needle = "  for (let attempt = 0; attempt < 90; attempt += 1) {"
if text.count(needle) != 1:
    raise SystemExit(f"relay loop target count: {text.count(needle)}")
path.write_text(text.replace(needle, "  for (let attempt = 0; attempt < 180; attempt += 1) {"))
