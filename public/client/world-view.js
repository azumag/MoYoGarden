import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { agentMethods } from "./agents.js";
import { resourceMethods } from "./resources.js";
import { structureMethods } from "./structures.js";
import { terrainMethods } from "./terrain.js";
import { WORLD_UP, clamp } from "./shared.js";

export class WorldView {
  constructor(canvas, models) {
    this.canvas = canvas;
    this.models = models;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c1d18);
    this.scene.fog = new THREE.FogExp2(0x0c1d18, 0.022);
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 180);
    this.cameraState = {
      yaw: -0.74,
      pitch: 0.68,
      distance: 34,
      target: new THREE.Vector3(0, 0.2, 0),
    };

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();

    this.hemi = new THREE.HemisphereLight(0xb7d9d0, 0x182018, 1.55);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d2, 4.1);
    this.sun.position.set(-18, 26, 14);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.00065;
    this.sun.shadow.normalBias = 0.025;
    this.sun.target.position.set(0, 0, 0);
    this.scene.add(this.sun, this.sun.target);

    this.worldRoot = new THREE.Group();
    this.resourceRoot = new THREE.Group();
    this.structureRoot = new THREE.Group();
    this.agentRoot = new THREE.Group();
    this.worldRoot.add(this.resourceRoot, this.structureRoot, this.agentRoot);
    this.scene.add(this.worldRoot);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.state = null;
    this.tickMs = 10_000;
    this.terrainMesh = null;
    this.waterMesh = null;
    this.detailRoot = null;
    this.resourceObjects = new Map();
    this.structureObjects = new Map();
    this.agentObjects = new Map();
    this.selectedAgentId = null;
    this.keys = new Set();
    this.drag = null;
    this.lastFrame = performance.now();
    this.onSelect = () => {};
    this.onCommand = () => {};

    this.bindInput();
    this.renderer.setAnimationLoop((time) => this.frame(time));
  }

  tileAt(x, y) {
    if (!this.state || x < 0 || y < 0 || x >= this.state.width || y >= this.state.height) {
      return null;
    }
    return this.state.tiles[y * this.state.width + x] || null;
  }

  terrainHeight(tile) {
    if (!tile) return 0;
    if (tile.terrain === "hill") return 0.62;
    if (tile.terrain === "forest") return 0.14;
    if (tile.terrain === "water") return -0.2;
    return 0;
  }

  worldPosition(position, lift = 0) {
    const tile = this.tileAt(position.x, position.y);
    return new THREE.Vector3(
      position.x - this.state.width / 2 + 0.5,
      this.terrainHeight(tile) + lift,
      position.y - this.state.height / 2 + 0.5,
    );
  }

  cameraVectors() {
    const { yaw, pitch, distance, target } = this.cameraState;
    const cosPitch = Math.cos(pitch);
    const eye = new THREE.Vector3(
      target.x + Math.sin(yaw) * cosPitch * distance,
      target.y + Math.sin(pitch) * distance,
      target.z + Math.cos(yaw) * cosPitch * distance,
    );
    const forward = target.clone().sub(eye);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, WORLD_UP).normalize();
    return { eye, forward, right };
  }

  updateCamera() {
    const { eye } = this.cameraVectors();
    this.camera.position.copy(eye);
    this.camera.lookAt(this.cameraState.target);
  }

  clampTarget() {
    if (!this.state) return;
    const halfWidth = Math.max(2, this.state.width / 2 - 0.4);
    const halfHeight = Math.max(2, this.state.height / 2 - 0.4);
    this.cameraState.target.x = clamp(this.cameraState.target.x, -halfWidth, halfWidth);
    this.cameraState.target.z = clamp(this.cameraState.target.z, -halfHeight, halfHeight);
  }

  createLod(high, medium, low, distances) {
    const lod = new THREE.LOD();
    if (high) lod.addLevel(high, distances[0]);
    if (medium) lod.addLevel(medium, distances[1]);
    if (low) lod.addLevel(low, distances[2]);
    lod.autoUpdate = true;
    return lod;
  }

  setState(state, tickMs = this.tickMs) {
    const terrainKey = `${state.worldId}:${state.seed}:${state.width}:${state.height}`;
    const previousKey = this.state
      ? `${this.state.worldId}:${this.state.seed}:${this.state.width}:${this.state.height}`
      : "";
    this.state = state;
    this.tickMs = tickMs;
    if (terrainKey !== previousKey || !this.terrainMesh) {
      this.buildTerrain(state);
      this.cameraState.distance = Math.max(state.width, state.height) * 1.12;
      this.cameraState.target.set(0, 0.2, 0);
    }
    this.syncResources(state);
    this.syncStructures(state);
    this.syncAgents(state);
  }

  frame(time) {
    const delta = Math.min(0.05, Math.max(0, (time - this.lastFrame) / 1000));
    this.lastFrame = time;
    this.resize();
    this.updateHeldKeys(delta);
    for (const entry of this.agentObjects.values()) this.animateAgent(entry, time);
    if (this.waterMesh) {
      const material = this.waterMesh.material;
      material.opacity = 0.68 + Math.sin(time * 0.0011) * 0.045;
      material.color.setHSL(0.54, 0.48, 0.29 + Math.sin(time * 0.0007) * 0.02);
    }
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.75);
    const targetWidth = Math.floor(width * ratio);
    const targetHeight = Math.floor(height * ratio);
    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }

  updateHeldKeys(delta) {
    if (!this.keys.size || !this.state) return;
    const { forward, right } = this.cameraVectors();
    let forwardAmount = 0;
    let rightAmount = 0;
    if (this.keys.has("w")) forwardAmount += 1;
    if (this.keys.has("s")) forwardAmount -= 1;
    if (this.keys.has("d")) rightAmount += 1;
    if (this.keys.has("a")) rightAmount -= 1;
    if (!forwardAmount && !rightAmount) return;
    const length = Math.hypot(forwardAmount, rightAmount) || 1;
    const speed = Math.max(2.4, this.cameraState.distance * 0.23) * delta;
    this.cameraState.target
      .addScaledVector(forward, forwardAmount / length * speed)
      .addScaledVector(right, rightAmount / length * speed);
    this.clampTarget();
  }

  pointerNdc(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  pickAgent(event) {
    this.pointerNdc(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(
      [...this.agentObjects.values()].map((entry) => entry.lod),
      true,
    );
    return hits.find((hit) => hit.object.userData.agentId)?.object.userData.agentId || null;
  }

  pickTile(event) {
    if (!this.terrainMesh || !this.state) return null;
    this.pointerNdc(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.terrainMesh, false)[0];
    if (!hit) return null;
    const x = Math.floor(hit.point.x + this.state.width / 2);
    const y = Math.floor(hit.point.z + this.state.height / 2);
    return this.tileAt(x, y) ? { x, y } : null;
  }

  bindInput() {
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault();
      this.canvas.focus();
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = {
        mode: event.button === 1 ? "pan" : "orbit",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
      };
      this.canvas.style.cursor = "grabbing";
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      const dx = event.clientX - this.drag.lastX;
      const dy = event.clientY - this.drag.lastY;
      if (Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) > 4) {
        this.drag.moved = true;
      }
      if (this.drag.mode === "orbit") {
        this.cameraState.yaw -= dx * 0.008;
        this.cameraState.pitch = clamp(this.cameraState.pitch + dy * 0.006, 0.18, 1.34);
      } else {
        const { forward, right } = this.cameraVectors();
        const amount = Math.max(0.0035, this.cameraState.distance * 0.00215);
        // Grab-map behavior: both axes are reversed from the previous release.
        this.cameraState.target
          .addScaledVector(right, -dx * amount)
          .addScaledVector(forward, dy * amount);
        this.clampTarget();
      }
      this.drag.lastX = event.clientX;
      this.drag.lastY = event.clientY;
    });

    const endDrag = (event) => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      if (this.drag.mode === "orbit" && !this.drag.moved) {
        this.selectedAgentId = this.pickAgent(event);
        for (const [id, entry] of this.agentObjects) {
          entry.ring.visible = id === this.selectedAgentId;
        }
        this.onSelect(this.selectedAgentId);
      }
      this.drag = null;
      this.canvas.style.cursor = "default";
    };
    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);
    this.canvas.addEventListener("lostpointercapture", () => {
      this.drag = null;
      this.canvas.style.cursor = "default";
    });
    this.canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const tile = this.pickTile(event);
      if (tile && this.selectedAgentId) this.onCommand(this.selectedAgentId, tile);
    });
    this.canvas.addEventListener("auxclick", (event) => {
      if (event.button === 1) event.preventDefault();
    });
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.cameraState.distance = clamp(
        this.cameraState.distance * Math.exp(event.deltaY * 0.001),
        6,
        78,
      );
    }, { passive: false });
    window.addEventListener("keydown", (event) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d"].includes(key)) {
        event.preventDefault();
        this.keys.add(key);
      }
    });
    window.addEventListener("keyup", (event) => this.keys.delete(event.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());
  }

  focusAgent(agentId) {
    const entry = this.agentObjects.get(agentId);
    if (!entry) return;
    this.cameraState.target.copy(entry.lod.position).setY(0.35);
    this.cameraState.distance = Math.min(this.cameraState.distance, 15);
    this.clampTarget();
  }
}

Object.assign(
  WorldView.prototype,
  terrainMethods,
  resourceMethods,
  structureMethods,
  agentMethods,
);
