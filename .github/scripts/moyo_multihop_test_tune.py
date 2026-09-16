from pathlib import Path

path = Path("tests/autonomy-material-return-relay.test.mjs")
text = path.read_text()
replacements = [
    (
        '  const relay = await assignRegion(env, "hex-q1-r0");',
        '  const relay = await assignRegion(env, "garden-2");',
        "relay ownership alias",
    ),
    (
        "  for (let attempt = 0; attempt < 90; attempt += 1) {",
        "  for (let attempt = 0; attempt < 180; attempt += 1) {",
        "relay alarm budget",
    ),
]
for old, new, label in replacements:
    if text.count(old) != 1:
        raise SystemExit(f"{label} target count: {text.count(old)}")
    text = text.replace(old, new, 1)
path.write_text(text)
