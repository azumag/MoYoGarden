(() => {
  "use strict";

  if (typeof renderer === "undefined" || !renderer?.canvas || !renderer?.camera) return;

  const canvas = renderer.canvas;
  const pan = { active: false, pointerId: null, x: 0, y: 0 };

  const clampTarget = () => {
    if (!renderer.state) return;
    const halfWidth = Math.max(2, renderer.state.width / 2 - 0.5);
    const halfHeight = Math.max(2, renderer.state.height / 2 - 0.5);
    renderer.camera.target[0] = Math.max(-halfWidth, Math.min(halfWidth, renderer.camera.target[0]));
    renderer.camera.target[2] = Math.max(-halfHeight, Math.min(halfHeight, renderer.camera.target[2]));
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    pan.active = true;
    pan.pointerId = event.pointerId;
    pan.x = event.clientX;
    pan.y = event.clientY;
    canvas.style.cursor = "grabbing";
  }, true);

  canvas.addEventListener("pointermove", (event) => {
    if (!pan.active || event.pointerId !== pan.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    pan.x = event.clientX;
    pan.y = event.clientY;

    const amount = Math.max(0.0035, renderer.camera.distance * 0.00215);
    const localX = -dx * amount;
    const localZ = -dy * amount;
    const c = Math.cos(renderer.camera.yaw);
    const s = Math.sin(renderer.camera.yaw);

    renderer.camera.target[0] += localX * c + localZ * s;
    renderer.camera.target[2] += -localX * s + localZ * c;
    clampTarget();
  }, true);

  const stopPan = (event) => {
    if (!pan.active || (event.pointerId !== undefined && event.pointerId !== pan.pointerId)) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    pan.active = false;
    pan.pointerId = null;
    canvas.style.cursor = "default";
  };

  canvas.addEventListener("pointerup", stopPan, true);
  canvas.addEventListener("pointercancel", stopPan, true);
  canvas.addEventListener("lostpointercapture", stopPan, true);
  canvas.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  canvas.addEventListener("mousedown", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, true);
})();