import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("manual region switching stays available only as a recovery/debug control", () => {
  const detailsStart = html.indexOf('<details id="manual-region-control">');
  const detailsEnd = html.indexOf("</details>", detailsStart);
  const selector = html.indexOf('id="region-select"');

  assert.ok(detailsStart >= 0, "manual region control should be collapsed behind details");
  assert.ok(detailsEnd > detailsStart, "manual region control should have a closing details element");
  assert.ok(selector > detailsStart && selector < detailsEnd, "region selector should remain in the recovery control for seamless handoff and debugging");
  assert.match(html, /Region はワールド内の移動に合わせて自動的に切り替わります。/);
});
