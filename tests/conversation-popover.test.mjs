import assert from "node:assert/strict";
import test from "node:test";

import { parseConversationEventText } from "../public/conversation-popover.js";

test("parses state-grounded agent conversation messages", () => {
  assert.deepEqual(
    parseConversationEventText('Mori to Aya: "I\'m gathering wood near 9,6."'),
    {
      speaker: "Mori",
      listener: "Aya",
      line: "I'm gathering wood near 9,6.",
    },
  );
});

test("ignores ordinary world events", () => {
  assert.equal(parseConversationEventText("Mori gathered 2 wood."), undefined);
  assert.equal(parseConversationEventText(""), undefined);
});
