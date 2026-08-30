import * as THREE from "three";
import { clamp, disposeObject, hash2, setObjectAgentId, setShadows } from "./shared.js";

export const agentMethods = {
  makeLowAgent(factionColor) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.18, 0.48, 4, 8),
      this.pbrMaterial(factionColor, 0.8),
    );
    body.position.y = 0.62;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.17, 8, 6),
      this.pbrMaterial(0xb58b67, 0.92),
    );
    head.position.y = 1.17;
    group.add(body, head);
    setShadows(group);
    return group;
  },

  createAgent(agent, faction) {
    const high = this.models.clone("settler", {
      factionColor: faction.color,
      role: agent.role,
      detail: "high",
    });
    const medium = this.models.clone("settler", {
      factionColor: faction.color,
      role: agent.role,
      detail: "mid",
    });
    const low = this.makeLowAgent(faction.color);
    const lod = this.createLod(high, medium, low, [0, 10, 25]);
    lod.scale.setScalar(0.72);
    setObjectAgentId(lod, agent.id);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.36, 0.48, 32),
      new THREE.MeshBasicMaterial({
        color: 0xc8ff66,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
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
        if (entry) disposeObject(entry.lod);
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
      disposeObject(entry.lod);
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
    const stride = moving ? Math.sin(phase) * 0.58 : Math.sin(phase * 0.2) * 0.02;
    const bob = moving
      ? Math.abs(Math.sin(phase)) * 0.045
      : Math.sin(phase * 0.25) * 0.01;

    for (const model of [entry.high, entry.medium]) {
      if (!model) continue;
      const leftLeg = model.getObjectByName("LeftLegPivot");
      const rightLeg = model.getObjectByName("RightLegPivot");
      const leftArm = model.getObjectByName("LeftArmPivot");
      const rightArm = model.getObjectByName("RightArmPivot");
      const torso = model.getObjectByName("FactionTorso");
      if (leftLeg) leftLeg.rotation.x = stride;
      if (rightLeg) rightLeg.rotation.x = -stride;
      if (leftArm) leftArm.rotation.x = -stride * 0.75;
      if (rightArm) rightArm.rotation.x = stride * 0.75;
      if (torso) torso.position.y = 1.05 + bob;
    }
    entry.ring.rotation.z = time * 0.0012;
  },
};
