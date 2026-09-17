from pathlib import Path

path = Path("tests/autonomy-material-return-relay.test.mjs")
text = path.read_text()
old = '''    claimId: "relay-renew-return",\n    agentId: courier.id,\n    resource: "wood",\n    direction: "W",'''
new = '''    claimId: "relay-renew-return",\n    agentId: undefined,\n    resource: "wood",\n    direction: "west",'''
count = text.count(old)
assert count == 1, f"expected one relay renewal fixture, got {count}"
path.write_text(text.replace(old, new, 1))
