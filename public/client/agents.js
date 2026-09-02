import * as THREE from "three";
import { clamp, disposeObject, hash2, setObjectAgentId, setShadows } from "./shared.js";

const AUTHORED_AGENT_BY_ROLE = Object.freeze({
  builder: "authored:agent-worker",
  miner: "authored:agent-worker",
  woodcutter: "authored:agent-worker",
  forager: "authored:agent-roamer",
  scout: "authored:agent-roamer",
  trader: "authored:agent-roamer",
});

function makeMaterial(color, roughness = 0.82, metalness = 0, emissive = null) {
  const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  if (emissive !== null) {
    material.emissive = new THREE.Color(emissive);
    material.emissiveIntensity = 1.35;
  }
  return material;
}

function addPart(group, geometry, material, position, rotation = null, scale = null, name = "") {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  if (scale) mesh.scale.set(...scale);
  if (name) mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function factionPalette(factionColor) {
  const faction = new THREE.Color(factionColor || "#8b8f8d");
  return {
    cloth: faction.clone().lerp(new THREE.Color(0x3e4742), 0.34),
    darkCloth: faction.clone().lerp(new THREE.Color(0x1e2522), 0.62),
    leather: new THREE.Color(0x4f3527),
    leatherDark: new THREE.Color(0x2c211b),
    metal: new THREE.Color(0x69706f),
  };
}

function reshapeSettler(model, detail) {
  if (!model) return;
  const torso = model.getObjectByName("FactionTorso");
  const head = model.getObjectByName("Head");
  const backpack = model.getObjectByName("detail_Backpack");
  if (torso) {
    torso.scale.x *= 1.04;
    torso.scale.y *= 1.08;
    torso.scale.z *= 0.9;
  }
  if (head) {
    head.scale.x *= 0.91;
    head.scale.y *= 1.02;
    head.scale.z *= 0.92;
  }
  if (backpack && detail === "high") {
    backpack.scale.x *= 0.88;
    backpack.scale.y *= 1.06;
    backpack.position.y -= 0.015;
  }
}

function addRoleHeadgear(group, role, palette, detail) {
  const cloth = makeMaterial(palette.darkCloth, 0.86);
  const leather = makeMaterial(palette.leather, 0.9);
  const metal = makeMaterial(palette.metal, 0.38, 0.52);
  const lamp = makeMaterial(0xf2c15b, 0.38, 0.08, 0xff9d32);

  if (role === "miner") {
    addPart(group, new THREE.SphereGeometry(0.225, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.56), metal, [0, 1.84, 0], null, [1.02, 0.86, 1.04], "MoyoHelmet");
    addPart(group, new THREE.CylinderGeometry(0.24, 0.24, 0.045, 14), metal, [0, 1.79, 0], null, [1.04, 1, 1.02]);
    if (detail === "high") addPart(group, new THREE.SphereGeometry(0.055, 8, 6), lamp, [0, 1.87, 0.205], null, null, "MoyoHeadLamp");
    return;
  }

  if (role === "builder") {
    addPart(group, new THREE.CylinderGeometry(0.255, 0.255, 0.035, 16), leather, [0, 1.84, 0]);
    addPart(group, new THREE.CylinderGeometry(0.17, 0.2, 0.18, 14), cloth, [0, 1.92, -0.005], [0.03, 0, 0]);
    return;
  }

  if (role === "trader") {
    addPart(group, new THREE.CylinderGeometry(0.29, 0.29, 0.028, 16), leather, [0, 1.83, 0]);
    addPart(group, new THREE.CylinderGeometry(0.155, 0.205, 0.16, 14), leather, [0, 1.91, 0], [0.06, 0, -0.04]);
    return;
  }

  if (role === "woodcutter") {
    addPart(group, new THREE.SphereGeometry(0.21, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.52), cloth, [0, 1.82, 0], null, [1.02, 0.86, 1.02]);
    addPart(group, new THREE.BoxGeometry(0.2, 0.035, 0.13), cloth, [0, 1.79, 0.17], [0.12, 0, 0]);
    return;
  }

  if (role === "forager") {
    const straw = makeMaterial(0x9b7b4d, 0.94);
    addPart(group, new THREE.ConeGeometry(0.31, 0.16, 14), straw, [0, 1.87, -0.005], null, [1, 1, 0.92], "MoyoForagerHat");
    return;
  }

  if (role === "scout") {
    addPart(group, new THREE.ConeGeometry(0.245, 0.34, 14, 1, true), cloth, [0, 1.77, -0.015], [0, 0, 0], [1, 1, 0.9], "MoyoHood");
  }
}

function decorateAgentModel(model, agent, factionColor, detail = "high") {
  if (!model || model.getObjectByName("MoyoAgentSilhouette")) return model;
  reshapeSettler(model, detail);
  const palette = factionPalette(factionColor);
  const group = new THREE.Group();
  group.name = "MoyoAgentSilhouette";

  const cloth = makeMaterial(palette.cloth, 0.88);
  const darkCloth = makeMaterial(palette.darkCloth, 0.9);
  const leather = makeMaterial(palette.leather, 0.91);
  const metal = makeMaterial(palette.metal, 0.36, 0.5);

  addPart(group, new THREE.CylinderGeometry(0.255, 0.31, 0.55, 10, 1, true), cloth, [0, 1.07, -0.012], null, [1.02, 1, 0.94], "MoyoCoat");
  addPart(group, new THREE.TorusGeometry(0.176, 0.035, 6, 14), darkCloth, [0, 1.47, 0], [Math.PI / 2, 0, 0], null, "MoyoScarf");

  for (const side of [-1, 1]) {
    addPart(group, new THREE.SphereGeometry(0.12, 10, 6), leather, [side * 0.31, 1.31, 0], null, [1.2, 0.55, 0.95], side < 0 ? "MoyoShoulderL" : "MoyoShoulderR");
  }

  const strap = addPart(group, new THREE.BoxGeometry(0.055, 0.68, 0.025), leather, [0.04, 1.1, 0.18], [0, 0, -0.48], null, "MoyoChestStrap");
  strap.castShadow = false;

  if (detail === "high") {
    addPart(group, new THREE.BoxGeometry(0.24, 0.34, 0.038), darkCloth, [-0.13, 0.67, -0.17], [-0.14, 0.08, 0.06], null, "MoyoCoatTailLeft");
    addPart(group, new THREE.BoxGeometry(0.24, 0.34, 0.038), darkCloth, [0.13, 0.67, -0.17], [-0.14, -0.08, -0.06], null, "MoyoCoatTailRight");
    addPart(group, new THREE.BoxGeometry(0.18, 0.19, 0.12), leather, [-0.31, 0.86, -0.02], [0, 0.08, 0.03], null, "MoyoPouch");
    if (agent.role === "builder" || agent.role === "miner") {
      addPart(group, new THREE.BoxGeometry(0.23, 0.28, 0.045), metal, [0, 1.08, 0.19], [0.02, 0, 0], null, "MoyoChestPlate");
    }
  }

  addRoleHeadgear(group, agent.role, palette, detail);
  model.add(group);
  setShadows(group);
  return model;
}

function fitAuthoredAgent(root, targetHeight = 1.85) {
  if (!root) return null;
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!Number.isFinite(size.y) || size.y <= 0.0001) return root;
  root.scale.multiplyScalar(targetHeight / size.y);
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  box.getCenter(center);
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.userData.moyoAuthoredAgent = true;
  root.updateMatrixWorld(true);
  return root;
}

function findClip(clips, patterns) {
  for (const pattern of patterns) {
    const clip = clips.find((value) => pattern.test(value.name || ""));
    if (clip) return clip;
  }
  return null;
}

function createAuthoredAnimation(models, modelKey, root) {
  if (!root?.userData?.moyoAuthoredAgent) return null;
  const clips = models.clips(modelKey);
  if (!clips.length) return null;
  const idleClip = findClip(clips, [/^idle$/i, /idle/i]);
  const moveClip = findClip(clips, [/walking[_ -]?a/i, /walk/i, /running[_ -]?a/i, /run/i]);
  if (!idleClip && !moveClip) return null;

  const mixer = new THREE.AnimationMixer(root);
  const idleAction = idleClip ? mixer.clipAction(idleClip) : null;
  const moveAction = moveClip ? mixer.clipAction(moveClip) : null;
  for (const action of [idleAction, moveAction]) {
    if (!action) continue;
    action.enabled = true;
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
  }
  const activeAction = idleAction || moveAction;
  activeAction?.play();
  return { mixer, idleAction, moveAction, activeAction };
}

function makeContactShadow() {
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.38, 24),
    new THREE.MeshBasicMaterial({
      color: 0x111713,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  shadow.name = "MoyoContactShadow";
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(1.25, 0.72, 1);
  shadow.position.y = 0.012;
  shadow.renderOrder = 1;
  return shadow;
}

export const agentMethods = {
  makeLowAgent(factionColor, role = "builder") {
    const group = new THREE.Group();
    const palette = factionPalette(factionColor);
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.17, 0.5, 5, 10),
      makeMaterial(palette.cloth, 0.86),
    );
    body.position.y = 0.66;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 8),
      makeMaterial(0xb78c6e, 0.92),
    );
    head.position.y = 1.18;
    group.add(body, head);
    addRoleHeadgear(group, role, palette, "mid");
    setShadows(group);
    return group;
  },

  disposeAgentEntry(entry) {
    if (!entry) return;
    if (entry.mixer) {
      entry.mixer.stopAllAction();
      if (entry.high) entry.mixer.uncacheRoot(entry.high);
    }
    disposeObject(entry.lod);
  },

  createAgent(agent, faction) {
    const authoredKey = AUTHORED_AGENT_BY_ROLE[agent.role] || "authored:agent-roamer";
    const authoredHigh = this.models.clone(authoredKey, {
      factionColor: faction.color,
      role: agent.role,
      detail: "high",
    });
    const high = authoredHigh
      ? fitAuthoredAgent(authoredHigh)
      : decorateAgentModel(this.models.clone("settler", {
        factionColor: faction.color,
        role: agent.role,
        detail: "high",
      }), agent, faction.color, "high");
    const medium = decorateAgentModel(this.models.clone("settler", {
      factionColor: faction.color,
      role: agent.role,
      detail: "mid",
    }), agent, faction.color, "mid");
    const low = this.makeLowAgent(faction.color, agent.role);
    if (this.quality.id === "balanced") setShadows(low, false, true);
    const lod = this.createLod(high, medium, low, [0, authoredHigh ? 9 : 11, 27]);
    lod.scale.setScalar(0.8);
    setObjectAgentId(lod, agent.id);

    const animation = authoredHigh ? createAuthoredAnimation(this.models, authoredKey, high) : null;
    const contactShadow = makeContactShadow();
    lod.add(contactShadow);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.38, 0.5, 36),
      new THREE.MeshBasicMaterial({
        color: 0xc8ff66,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    ring.visible = agent.id === this.selectedAgentId;
    ring.userData.agentId = agent.id;
    lod.add(ring);
    this.agentRoot.add(lod);

    const target = this.worldPosition(agent.position, 0);
    lod.position.copy(target);
    return {
      lod,
      high,
      medium,
      low,
      ring,
      contactShadow,
      authoredKey: authoredHigh ? authoredKey : null,
      mixer: animation?.mixer || null,
      idleAction: animation?.idleAction || null,
      moveAction: animation?.moveAction || null,
      activeAction: animation?.activeAction || null,
      lastMixerTime: performance.now(),
      from: target.clone(),
      to: target.clone(),
      start: performance.now(),
      agent,
      role: agent.role,
      factionId: agent.factionId,
    };
  },

  syncAgents(state) {
    const live = new Set();
    const now = performance.now();
    for (const agent of state.agents) {
      live.add(agent.id);
      const faction = state.factions.find((value) => value.id === agent.factionId)
        || { color: "#999999" };
      let entry = this.agentObjects.get(agent.id);
      if (!entry || entry.role !== agent.role || entry.factionId !== agent.factionId) {
        if (entry) this.disposeAgentEntry(entry);
        entry = this.createAgent(agent, faction);
        this.agentObjects.set(agent.id, entry);
      }
      entry.from.copy(entry.lod.position);
      entry.to.copy(this.worldPosition(agent.position, 0));
      entry.start = now;
      entry.agent = agent;
      entry.ring.visible = agent.id === this.selectedAgentId;
      const task = agent.task?.target;
      if (task) {
        entry.lod.rotation.y = Math.atan2(
          task.x - agent.position.x,
          task.y - agent.position.y,
        );
      }
    }
    for (const [id, entry] of this.agentObjects) {
      if (live.has(id)) continue;
      this.disposeAgentEntry(entry);
      this.agentObjects.delete(id);
    }
    if (this.selectedAgentId && !live.has(this.selectedAgentId)) {
      this.selectedAgentId = null;
      this.onSelect(null);
    }
  },

  animateAgent(entry, time) {
    const duration = Math.max(300, this.tickMs * 0.82);
    const amount = clamp((time - entry.start) / duration, 0, 1);
    entry.lod.position.lerpVectors(entry.from, entry.to, amount);

    const agent = entry.agent;
    const moving = entry.from.distanceToSquared(entry.to) > 0.001
      || /moving|travel|gather|haul/i.test(agent.status || "");
    const phase = time * 0.0075
      + hash2(agent.position.x, agent.position.y, agent.id.length) * Math.PI * 2;
    const stride = moving ? Math.sin(phase) * 0.54 : Math.sin(phase * 0.2) * 0.02;
    const bob = moving
      ? Math.abs(Math.sin(phase)) * 0.04
      : Math.sin(phase * 0.25) * 0.009;

    if (entry.mixer && entry.high?.visible) {
      const desired = moving ? (entry.moveAction || entry.idleAction) : (entry.idleAction || entry.moveAction);
      if (desired && desired !== entry.activeAction) {
        entry.activeAction?.fadeOut(0.18);
        desired.reset().fadeIn(0.18).play();
        entry.activeAction = desired;
      }
      const mixerDelta = clamp((time - entry.lastMixerTime) / 1000, 0, 0.08);
      entry.lastMixerTime = time;
      entry.mixer.update(mixerDelta);
    } else if (entry.mixer) {
      entry.lastMixerTime = time;
    }

    for (const model of [entry.high, entry.medium]) {
      if (!model || model.userData?.moyoAuthoredAgent) continue;
      const leftLeg = model.getObjectByName("LeftLegPivot");
      const rightLeg = model.getObjectByName("RightLegPivot");
      const leftArm = model.getObjectByName("LeftArmPivot");
      const rightArm = model.getObjectByName("RightArmPivot");
      const torso = model.getObjectByName("FactionTorso");
      const tailLeft = model.getObjectByName("MoyoCoatTailLeft");
      const tailRight = model.getObjectByName("MoyoCoatTailRight");
      if (leftLeg) leftLeg.rotation.x = stride;
      if (rightLeg) rightLeg.rotation.x = -stride;
      if (leftArm) leftArm.rotation.x = -stride * 0.72;
      if (rightArm) rightArm.rotation.x = stride * 0.72;
      if (torso) torso.position.y = 1.05 + bob;
      if (tailLeft) tailLeft.rotation.x = -0.14 + (moving ? Math.abs(Math.sin(phase)) * 0.18 : 0.02);
      if (tailRight) tailRight.rotation.x = -0.14 + (moving ? Math.abs(Math.sin(phase + 0.55)) * 0.18 : 0.02);
    }
    if (entry.contactShadow) {
      entry.contactShadow.material.opacity = moving ? 0.13 : 0.17;
      entry.contactShadow.scale.x = moving ? 1.36 : 1.25;
    }
    entry.ring.rotation.z = time * 0.0012;
  },
};