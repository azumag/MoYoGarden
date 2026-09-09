import assert from "node:assert/strict";
import test from "node:test";
import "../public/client/hex-footprint-rendering.js";
import { WorldView } from "../public/client/world-view.js";

function viewState(width = 40, height = 24) {
  return {
    width,
    height,
    tiles: Array.from({ length: width * height }, (_, index) => ({
      x: index % width,
      y: Math.floor(index / width),
      terrain: "plain",
    })),
  };
}

test("client tile lookup rejects clipped rectangular corner cells outside the active hex", () => {
  const view = Object.create(WorldView.prototype);
  view.state = viewState();

  assert.equal(view.tileAt(19, 0)?.x, 19, "top hex edge must stay interactive");
  assert.equal(view.tileAt(30, 0)?.x, 30, "top-right active edge must stay interactive");
  assert.equal(view.tileAt(18, 0), null, "clipped top-left compatibility cell must not be pickable");
  assert.equal(view.tileAt(31, 0), null, "clipped top-right compatibility cell must not be pickable");
  assert.equal(view.tileAt(0, 0), null, "rectangular storage corner must remain non-interactive");
  assert.equal(view.tileAt(19, 11)?.x, 19, "center hex cell must stay interactive");
});
