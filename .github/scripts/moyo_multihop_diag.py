from pathlib import Path

path = Path("tests/autonomy-material-return-relay.test.mjs")
text = path.read_text()
loop = '''  for (let attempt = 0; attempt < 180; attempt += 1) {
    await first.object.alarm(); await relay.object.alarm(); await origin.object.alarm();
    const storehouse = origin.object.runtime.snapshot().structures.find((entry) => entry.id === "origin-storehouse");
    if ((storehouse?.storage.wood ?? 0) >= 4) { deposited = true; break; }
  }
'''
replacement = '''  let loggedRelayArrival = false;
  const promotedCourierId = "agent-global:hex-q0-r0:agent-ember-builder";
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await first.object.alarm();
    const relayCourierBeforeTick = relay.object.runtime.snapshot().agents.find((entry) => entry.id === promotedCourierId);
    if (relayCourierBeforeTick !== undefined && !loggedRelayArrival) {
      loggedRelayArrival = true;
      console.error("MULTIHOP_BEFORE_RELAY_TICK", JSON.stringify({
        attempt,
        courier: relayCourierBeforeTick,
        arrivalClaims: await relay.state.storage.get(ARRIVAL_CLAIMS_KEY),
        autonomyHandoff: await relay.state.storage.get("handoff:autonomy:v1"),
      }));
    }
    await relay.object.alarm();
    if (relayCourierBeforeTick !== undefined && attempt < 90) {
      const relayCourierAfterTick = relay.object.runtime.snapshot().agents.find((entry) => entry.id === promotedCourierId);
      console.error("MULTIHOP_AFTER_RELAY_TICK", JSON.stringify({
        attempt,
        courier: relayCourierAfterTick,
        arrivalClaims: await relay.state.storage.get(ARRIVAL_CLAIMS_KEY),
        autonomyHandoff: await relay.state.storage.get("handoff:autonomy:v1"),
      }));
    }
    await origin.object.alarm();
    const storehouse = origin.object.runtime.snapshot().structures.find((entry) => entry.id === "origin-storehouse");
    if ((storehouse?.storage.wood ?? 0) >= 4) { deposited = true; break; }
  }
'''
if text.count(loop) != 1:
    raise SystemExit(f"loop target count: {text.count(loop)}")
text = text.replace(loop, replacement, 1)
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
