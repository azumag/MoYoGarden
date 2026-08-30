(() => {
  "use strict";

  if (typeof WebGLWorld === "undefined" || typeof renderer === "undefined") {
    console.warn("MoYoGarden detail upgrade could not find the base renderer.");
    return;
  }

  const detailHash = (x, y, salt = 0) => {
    let value = Math.imul((x + 101 + salt * 17) | 0, 374761393) ^ Math.imul((y + 173 + salt * 31) | 0, 668265263);
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
  };

  const detailShade = (color, factor) => color.map((channel) => clamp(channel * factor, 0, 1));
  const detailMix = (a, b, amount) => a.map((channel, index) => lerp(channel, b[index], amount));
  const detailOffset = (base, localX, localY, localZ, yaw = 0) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [
      base[0] + localX * c + localZ * s,
      base[1] + localY,
      base[2] - localX * s + localZ * c,
    ];
  };

  function detailCylinderGeometry(segments = 12, topRadius = 0.5, bottomRadius = 0.5) {
    const positions = [], normals = [], colors = [], indices = [];
    for (let index = 0; index <= segments; index += 1) {
      const angle = index / segments * Math.PI * 2;
      const x = Math.cos(angle), z = Math.sin(angle);
      positions.push(x * bottomRadius, -0.5, z * bottomRadius, x * topRadius, 0.5, z * topRadius);
      normals.push(x, 0, z, x, 0, z);
      colors.push(1, 1, 1, 1, 1, 1);
    }
    for (let index = 0; index < segments; index += 1) {
      const base = index * 2;
      indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }
    const bottomCenter = positions.length / 3;
    positions.push(0, -0.5, 0); normals.push(0, -1, 0); colors.push(1, 1, 1);
    const topCenter = positions.length / 3;
    positions.push(0, 0.5, 0); normals.push(0, 1, 0); colors.push(1, 1, 1);
    for (let index = 0; index < segments; index += 1) {
      const angleA = index / segments * Math.PI * 2;
      const angleB = (index + 1) / segments * Math.PI * 2;
      const bottomA = positions.length / 3;
      positions.push(Math.cos(angleA) * bottomRadius, -0.5, Math.sin(angleA) * bottomRadius);
      normals.push(0, -1, 0); colors.push(1, 1, 1);
      const bottomB = positions.length / 3;
      positions.push(Math.cos(angleB) * bottomRadius, -0.5, Math.sin(angleB) * bottomRadius);
      normals.push(0, -1, 0); colors.push(1, 1, 1);
      indices.push(bottomCenter, bottomB, bottomA);

      const topA = positions.length / 3;
      positions.push(Math.cos(angleA) * topRadius, 0.5, Math.sin(angleA) * topRadius);
      normals.push(0, 1, 0); colors.push(1, 1, 1);
      const topB = positions.length / 3;
      positions.push(Math.cos(angleB) * topRadius, 0.5, Math.sin(angleB) * topRadius);
      normals.push(0, 1, 0); colors.push(1, 1, 1);
      indices.push(topCenter, topA, topB);
    }
    return { positions, normals, colors, indices };
  }

  function detailSphereGeometry(latitudeSegments = 7, longitudeSegments = 10) {
    const positions = [], normals = [], colors = [], indices = [];
    for (let latitude = 0; latitude <= latitudeSegments; latitude += 1) {
      const v = latitude / latitudeSegments;
      const phi = v * Math.PI;
      const y = Math.cos(phi);
      const radius = Math.sin(phi);
      for (let longitude = 0; longitude <= longitudeSegments; longitude += 1) {
        const u = longitude / longitudeSegments;
        const theta = u * Math.PI * 2;
        const x = radius * Math.cos(theta), z = radius * Math.sin(theta);
        positions.push(x * 0.5, y * 0.5, z * 0.5);
        normals.push(x, y, z); colors.push(1, 1, 1);
      }
    }
    const row = longitudeSegments + 1;
    for (let latitude = 0; latitude < latitudeSegments; latitude += 1) {
      for (let longitude = 0; longitude < longitudeSegments; longitude += 1) {
        const a = latitude * row + longitude;
        const b = a + row;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    return { positions, normals, colors, indices };
  }

  function detailTorusGeometry(radialSegments = 8, tubularSegments = 20, majorRadius = 0.38, tubeRadius = 0.065) {
    const positions = [], normals = [], colors = [], indices = [];
    for (let radial = 0; radial <= radialSegments; radial += 1) {
      const v = radial / radialSegments * Math.PI * 2;
      const cv = Math.cos(v), sv = Math.sin(v);
      for (let tubular = 0; tubular <= tubularSegments; tubular += 1) {
        const u = tubular / tubularSegments * Math.PI * 2;
        const cu = Math.cos(u), su = Math.sin(u);
        const radius = majorRadius + tubeRadius * cv;
        positions.push(radius * cu, tubeRadius * sv, radius * su);
        normals.push(cv * cu, sv, cv * su); colors.push(1, 1, 1);
      }
    }
    const row = tubularSegments + 1;
    for (let radial = 0; radial < radialSegments; radial += 1) {
      for (let tubular = 0; tubular < tubularSegments; tubular += 1) {
        const a = radial * row + tubular;
        const b = a + row;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    return { positions, normals, colors, indices };
  }

  function detailGableGeometry() {
    const positions = [], normals = [], colors = [], indices = [];
    const addTriangle = (a, b, c) => {
      const normal = normalize(cross(subtract(b, a), subtract(c, a)));
      const base = positions.length / 3;
      for (const point of [a, b, c]) { positions.push(...point); normals.push(...normal); colors.push(1, 1, 1); }
      indices.push(base, base + 1, base + 2);
    };
    const addQuad = (a, b, c, d) => {
      const normal = normalize(cross(subtract(b, a), subtract(c, a)));
      const base = positions.length / 3;
      for (const point of [a, b, c, d]) { positions.push(...point); normals.push(...normal); colors.push(1, 1, 1); }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const left = -0.5, right = 0.5, low = -0.5, high = 0.5, front = 0.5, back = -0.5;
    addTriangle([left, low, front], [left, low, back], [left, high, 0]);
    addTriangle([right, low, back], [right, low, front], [right, high, 0]);
    addQuad([left, low, back], [right, low, back], [right, high, 0], [left, high, 0]);
    addQuad([left, high, 0], [right, high, 0], [right, low, front], [left, low, front]);
    addQuad([left, low, front], [right, low, front], [right, low, back], [left, low, back]);
    return { positions, normals, colors, indices };
  }

  WebGLWorld.prototype.terrainHeight = function terrainHeightDetailed(tile) {
    if (!tile) return 0;
    const wave = Math.sin((tile.x + (this.state?.seed ?? 1) * 0.001) * 0.71) * Math.cos(tile.y * 0.63);
    if (tile.terrain === "water") return -0.26 + wave * 0.018;
    if (tile.terrain === "hill") return 0.48 + wave * 0.13;
    if (tile.terrain === "forest") return 0.09 + wave * 0.045;
    return 0.015 + wave * 0.055;
  };

  WebGLWorld.prototype.buildTerrain = function buildDetailedTerrain(state) {
    const positions = [], normals = [], colors = [], indices = [];
    const waterPositions = [], waterNormals = [], waterColors = [], waterIndices = [];
    const tileAtState = (x, y) => x >= 0 && y >= 0 && x < state.width && y < state.height
      ? state.tiles[y * state.width + x]
      : null;

    for (const tile of state.tiles) {
      const x = tile.x - state.width / 2, z = tile.y - state.height / 2;
      const height = this.terrainHeight(tile);
      const variation = 0.9 + detailHash(tile.x, tile.y, 2) * 0.18;
      const baseColor = TERRAIN_COLORS[tile.terrain] || TERRAIN_COLORS.plain;
      const color = detailShade(baseColor, variation);
      pushFace(positions, normals, colors, indices,
        [[x, height, z], [x + 1, height, z], [x + 1, height, z + 1], [x, height, z + 1]], [0, 1, 0], color);

      if (tile.terrain === "water") {
        const waterColor = detailMix([0.08, 0.29, 0.39], [0.18, 0.52, 0.58], detailHash(tile.x, tile.y, 4));
        pushFace(waterPositions, waterNormals, waterColors, waterIndices,
          [[x, height + 0.035, z], [x + 1, height + 0.035, z], [x + 1, height + 0.035, z + 1], [x, height + 0.035, z + 1]],
          [0, 1, 0], waterColor);
      }

      const east = tileAtState(tile.x + 1, tile.y);
      const south = tileAtState(tile.x, tile.y + 1);
      const eastHeight = east ? this.terrainHeight(east) : -0.6;
      const southHeight = south ? this.terrainHeight(south) : -0.6;
      if (height > eastHeight + 0.025) {
        pushFace(positions, normals, colors, indices,
          [[x + 1, eastHeight, z], [x + 1, eastHeight, z + 1], [x + 1, height, z + 1], [x + 1, height, z]],
          [1, 0, 0], detailShade(color, 0.7));
      }
      if (height > southHeight + 0.025) {
        pushFace(positions, normals, colors, indices,
          [[x, southHeight, z + 1], [x + 1, southHeight, z + 1], [x + 1, height, z + 1], [x, height, z + 1]],
          [0, 0, 1], detailShade(color, 0.76));
      }
    }

    if (this.terrainMesh?.vao) this.gl.deleteVertexArray(this.terrainMesh.vao);
    if (this.waterMesh?.vao) this.gl.deleteVertexArray(this.waterMesh.vao);
    this.terrainMesh = this.createMesh({ positions, normals, colors, indices });
    this.waterMesh = waterIndices.length > 0
      ? this.createMesh({ positions: waterPositions, normals: waterNormals, colors: waterColors, indices: waterIndices })
      : null;
  };

  WebGLWorld.prototype.drawGroundDetail = function drawGroundDetail(tile) {
    if (tile.terrain === "water" || tile.resource) return;
    const chance = detailHash(tile.x, tile.y, 8);
    if (chance < 0.76) return;
    const base = this.worldPosition(tile, 0.025);
    const ox = (detailHash(tile.x, tile.y, 9) - 0.5) * 0.62;
    const oz = (detailHash(tile.x, tile.y, 10) - 0.5) * 0.62;
    if (tile.terrain === "hill") {
      this.draw(this.meshes.sphere, [base[0] + ox, base[1] + 0.07, base[2] + oz], [0.18, 0.12, 0.15], [0.46, 0.45, 0.41], chance * 4);
      if (chance > 0.9) this.draw(this.meshes.sphere, [base[0] + ox + 0.16, base[1] + 0.045, base[2] + oz - 0.08], [0.11, 0.08, 0.1], [0.57, 0.54, 0.47]);
    } else if (tile.terrain === "forest") {
      this.draw(this.meshes.cylinder, [base[0] + ox, base[1] + 0.11, base[2] + oz], [0.025, 0.22, 0.025], [0.36, 0.25, 0.13]);
      this.draw(this.meshes.sphere, [base[0] + ox, base[1] + 0.25, base[2] + oz], [0.16, 0.13, 0.16], [0.24, 0.46, 0.22]);
    } else {
      const grass = detailMix([0.28, 0.53, 0.24], [0.55, 0.64, 0.24], chance);
      this.draw(this.meshes.cylinder, [base[0] + ox, base[1] + 0.075, base[2] + oz], [0.018, 0.15, 0.018], grass);
      this.draw(this.meshes.cylinder, [base[0] + ox + 0.055, base[1] + 0.06, base[2] + oz - 0.035], [0.014, 0.12, 0.014], detailShade(grass, 0.92));
    }
  };

  WebGLWorld.prototype.drawResource = function drawDetailedResource(tile) {
    if (!tile.resource || tile.resource.amount <= 0 || tile.terrain === "water") return;
    const base = this.worldPosition(tile, 0.025);
    const density = clamp(tile.resource.amount / Math.max(1, tile.resource.maxAmount), 0.2, 1);
    const count = density > 0.72 ? 3 : density > 0.42 ? 2 : 1;

    if (tile.resource.kind === "wood") {
      for (let index = 0; index < count; index += 1) {
        const ox = (detailHash(tile.x, tile.y, 20 + index * 2) - 0.5) * 0.56;
        const oz = (detailHash(tile.x, tile.y, 21 + index * 2) - 0.5) * 0.56;
        const size = (0.78 + detailHash(tile.x, tile.y, 26 + index) * 0.28) * (0.82 + density * 0.18);
        const trunkBase = [base[0] + ox, base[1], base[2] + oz];
        this.draw(this.meshes.sphere, [trunkBase[0], trunkBase[1] + 0.025, trunkBase[2]], [0.34 * size, 0.035, 0.27 * size], [0.035, 0.065, 0.04], 0, 0.34);
        this.draw(this.meshes.cylinder, [trunkBase[0], trunkBase[1] + 0.35 * size, trunkBase[2]], [0.105 * size, 0.7 * size, 0.105 * size], [0.35, 0.22, 0.1]);
        const foliageA = detailMix([0.12, 0.36, 0.17], [0.25, 0.53, 0.22], detailHash(tile.x, tile.y, 30 + index));
        this.draw(this.meshes.sphere, [trunkBase[0], trunkBase[1] + 0.83 * size, trunkBase[2]], [0.69 * size, 0.62 * size, 0.64 * size], foliageA);
        this.draw(this.meshes.sphere, [trunkBase[0] - 0.22 * size, trunkBase[1] + 0.76 * size, trunkBase[2] + 0.1 * size], [0.42 * size, 0.38 * size, 0.4 * size], detailShade(foliageA, 0.88));
        this.draw(this.meshes.sphere, [trunkBase[0] + 0.2 * size, trunkBase[1] + 0.9 * size, trunkBase[2] - 0.12 * size], [0.4 * size, 0.42 * size, 0.38 * size], detailShade(foliageA, 1.08));
      }
      return;
    }

    if (tile.resource.kind === "stone") {
      for (let index = 0; index < count + 1; index += 1) {
        const ox = (detailHash(tile.x, tile.y, 40 + index * 2) - 0.5) * 0.58;
        const oz = (detailHash(tile.x, tile.y, 41 + index * 2) - 0.5) * 0.58;
        const size = 0.27 + detailHash(tile.x, tile.y, 46 + index) * 0.24;
        const rockColor = detailMix([0.4, 0.42, 0.4], [0.65, 0.63, 0.56], detailHash(tile.x, tile.y, 50 + index));
        this.draw(this.meshes.sphere, [base[0] + ox, base[1] + size * 0.36, base[2] + oz], [size * 1.18, size * 0.72, size], rockColor, detailHash(tile.x, tile.y, 55 + index) * Math.PI);
      }
      return;
    }

    const bushColor = detailMix([0.25, 0.48, 0.2], [0.47, 0.6, 0.2], detailHash(tile.x, tile.y, 60));
    this.draw(this.meshes.sphere, [base[0], base[1] + 0.17, base[2]], [0.52, 0.32, 0.47], bushColor);
    this.draw(this.meshes.sphere, [base[0] - 0.23, base[1] + 0.19, base[2] + 0.05], [0.3, 0.28, 0.31], detailShade(bushColor, 0.86));
    this.draw(this.meshes.sphere, [base[0] + 0.22, base[1] + 0.22, base[2] - 0.08], [0.32, 0.31, 0.3], detailShade(bushColor, 1.05));
    const berryColor = tile.resource.kind === "food" ? [0.92, 0.36, 0.16] : [0.78, 0.72, 0.2];
    for (let index = 0; index < Math.max(3, Math.round(density * 7)); index += 1) {
      const angle = detailHash(tile.x, tile.y, 70 + index) * Math.PI * 2;
      const radius = 0.14 + detailHash(tile.x, tile.y, 80 + index) * 0.2;
      this.draw(this.meshes.sphere,
        [base[0] + Math.cos(angle) * radius, base[1] + 0.23 + detailHash(tile.x, tile.y, 90 + index) * 0.2, base[2] + Math.sin(angle) * radius],
        [0.055, 0.055, 0.055], berryColor);
    }
  };

  WebGLWorld.prototype.drawStructure = function drawDetailedStructure(structure) {
    const base = this.worldPosition(structure.position, 0);
    const faction = this.state.factions.find((entry) => entry.id === structure.factionId);
    const factionColor = hexColor(faction?.color);
    const active = structure.status === "active";
    const progress = active ? 1 : clamp(structure.progress / Math.max(1, structure.requiredProgress), 0.08, 1);
    const yaw = detailHash(structure.position.x, structure.position.y, 120) > 0.5 ? 0 : Math.PI / 2;

    this.draw(this.meshes.sphere, [base[0], base[1] + 0.025, base[2]], [0.68, 0.035, 0.62], [0.035, 0.06, 0.04], yaw, 0.38);

    if (!active) {
      const scaffoldHeight = 0.22 + progress * 0.9;
      this.draw(this.meshes.box, [base[0], base[1] + 0.07, base[2]], [0.96, 0.14, 0.9], [0.42, 0.39, 0.31], yaw, 0.8);
      for (const [x, z] of [[-0.42, -0.38], [0.42, -0.38], [-0.42, 0.38], [0.42, 0.38]]) {
        const post = detailOffset(base, x, scaffoldHeight / 2, z, yaw);
        this.draw(this.meshes.cylinder, post, [0.045, scaffoldHeight, 0.045], [0.55, 0.38, 0.19], yaw, 0.78);
      }
      if (progress > 0.35) this.draw(this.meshes.box, detailOffset(base, 0, scaffoldHeight * 0.7, 0, yaw), [1.0, 0.07, 0.07], [0.66, 0.48, 0.25], yaw, 0.7);
      if (progress > 0.65) this.draw(this.meshes.gable, detailOffset(base, 0, scaffoldHeight + 0.17, 0, yaw), [1.05, 0.34, 0.98], factionColor, yaw, 0.32);
      return;
    }

    const drawFlag = (localX, localZ, height = 1.28) => {
      const pole = detailOffset(base, localX, height / 2, localZ, yaw);
      this.draw(this.meshes.cylinder, pole, [0.025, height, 0.025], [0.28, 0.24, 0.18]);
      this.draw(this.meshes.box, detailOffset(base, localX + 0.13, height - 0.12, localZ, yaw), [0.25, 0.18, 0.035], factionColor, yaw);
    };

    if (structure.type === "camp") {
      const canvas = detailMix([0.56, 0.43, 0.27], factionColor, 0.28);
      this.draw(this.meshes.gable, detailOffset(base, -0.08, 0.43, 0, yaw), [1.02, 0.78, 0.84], canvas, yaw);
      this.draw(this.meshes.box, detailOffset(base, -0.08, 0.22, 0.43, yaw), [0.34, 0.42, 0.035], [0.11, 0.09, 0.07], yaw);
      this.draw(this.meshes.cylinder, detailOffset(base, -0.08, 0.46, 0.44, yaw), [0.028, 0.92, 0.028], [0.36, 0.25, 0.13]);
      const fireBase = detailOffset(base, 0.55, 0, 0.15, yaw);
      for (let index = 0; index < 6; index += 1) {
        const angle = index / 6 * Math.PI * 2;
        this.draw(this.meshes.sphere, [fireBase[0] + Math.cos(angle) * 0.16, base[1] + 0.06, fireBase[2] + Math.sin(angle) * 0.16], [0.11, 0.08, 0.1], [0.45, 0.43, 0.39]);
      }
      this.draw(this.meshes.box, [fireBase[0], base[1] + 0.11, fireBase[2]], [0.34, 0.055, 0.07], [0.34, 0.19, 0.08], yaw + 0.7);
      this.draw(this.meshes.pyramid, [fireBase[0], base[1] + 0.27, fireBase[2]], [0.2, 0.34, 0.2], [1, 0.48, 0.12], 0, 0.9);
      drawFlag(-0.54, -0.37, 1.35);
      return;
    }

    if (structure.type === "storehouse") {
      this.draw(this.meshes.box, detailOffset(base, 0, 0.1, 0, yaw), [1.12, 0.2, 1.0], [0.34, 0.31, 0.25], yaw);
      this.draw(this.meshes.box, detailOffset(base, 0, 0.53, 0, yaw), [0.96, 0.72, 0.82], [0.55, 0.43, 0.28], yaw);
      this.draw(this.meshes.gable, detailOffset(base, 0, 1.03, 0, yaw), [1.12, 0.52, 1.02], detailMix([0.27, 0.2, 0.16], factionColor, 0.18), yaw);
      for (const [x, z] of [[-0.44, -0.36], [0.44, -0.36], [-0.44, 0.36], [0.44, 0.36]]) {
        this.draw(this.meshes.box, detailOffset(base, x, 0.55, z, yaw), [0.075, 0.82, 0.075], [0.28, 0.19, 0.1], yaw);
      }
      this.draw(this.meshes.box, detailOffset(base, 0, 0.38, 0.421, yaw), [0.32, 0.56, 0.035], [0.23, 0.16, 0.1], yaw);
      this.draw(this.meshes.box, detailOffset(base, 0.28, 0.59, 0.423, yaw), [0.18, 0.22, 0.025], [0.57, 0.75, 0.72], yaw, 0.8);
      this.draw(this.meshes.box, detailOffset(base, 0.58, 0.18, 0.34, yaw), [0.28, 0.28, 0.28], [0.5, 0.34, 0.18], yaw);
      drawFlag(-0.52, -0.42, 1.52);
      return;
    }

    if (structure.type === "market") {
      this.draw(this.meshes.box, detailOffset(base, 0, 0.08, 0, yaw), [1.22, 0.16, 1.0], [0.4, 0.32, 0.2], yaw);
      for (const [x, z] of [[-0.48, -0.38], [0.48, -0.38], [-0.48, 0.38], [0.48, 0.38]]) {
        this.draw(this.meshes.cylinder, detailOffset(base, x, 0.62, z, yaw), [0.035, 1.08, 0.035], [0.34, 0.24, 0.13]);
      }
      this.draw(this.meshes.pyramid, detailOffset(base, 0, 1.14, 0, yaw), [1.35, 0.36, 1.12], detailMix(factionColor, [0.93, 0.78, 0.4], 0.42), yaw);
      this.draw(this.meshes.box, detailOffset(base, 0, 0.42, 0.32, yaw), [0.98, 0.34, 0.24], [0.52, 0.34, 0.17], yaw);
      this.draw(this.meshes.box, detailOffset(base, -0.4, 0.22, -0.2, yaw), [0.28, 0.28, 0.28], [0.61, 0.42, 0.2], yaw);
      this.draw(this.meshes.box, detailOffset(base, 0.42, 0.19, -0.24, yaw), [0.32, 0.22, 0.32], [0.45, 0.3, 0.16], yaw);
      this.draw(this.meshes.box, detailOffset(base, 0, 0.9, 0.39, yaw), [0.46, 0.18, 0.035], factionColor, yaw);
      return;
    }

    const wallColor = structure.type === "workshop" ? [0.45, 0.44, 0.4] : STRUCTURE_COLORS[structure.type] || [0.5, 0.45, 0.35];
    this.draw(this.meshes.box, detailOffset(base, 0, 0.11, 0, yaw), [1.14, 0.22, 1.02], [0.28, 0.28, 0.25], yaw);
    this.draw(this.meshes.box, detailOffset(base, 0, 0.61, 0, yaw), [0.98, 0.82, 0.84], wallColor, yaw);
    this.draw(this.meshes.gable, detailOffset(base, 0, 1.18, 0, yaw), [1.13, 0.5, 1.02], detailMix([0.25, 0.22, 0.2], factionColor, 0.14), yaw);
    this.draw(this.meshes.box, detailOffset(base, -0.18, 0.44, 0.425, yaw), [0.34, 0.62, 0.035], [0.22, 0.17, 0.13], yaw);
    this.draw(this.meshes.box, detailOffset(base, 0.29, 0.66, 0.426, yaw), [0.22, 0.25, 0.025], [0.58, 0.75, 0.76], yaw, 0.82);
    const chimney = detailOffset(base, 0.33, 1.21, -0.2, yaw);
    this.draw(this.meshes.cylinder, chimney, [0.12, 0.72, 0.12], [0.28, 0.27, 0.25]);
    const smokeTime = performance.now() * 0.00035;
    for (let index = 0; index < 3; index += 1) {
      this.draw(this.meshes.sphere,
        [chimney[0] + Math.sin(smokeTime * 5 + index) * 0.04, chimney[1] + 0.46 + index * 0.17, chimney[2] + Math.cos(smokeTime * 4 + index) * 0.035],
        [0.18 + index * 0.035, 0.13 + index * 0.025, 0.18 + index * 0.035], [0.46, 0.48, 0.46], 0, 0.22);
    }
    this.draw(this.meshes.box, detailOffset(base, 0.56, 0.28, 0.15, yaw), [0.46, 0.18, 0.26], [0.38, 0.25, 0.13], yaw);
    this.draw(this.meshes.box, detailOffset(base, 0.56, 0.43, 0.15, yaw), [0.25, 0.08, 0.14], [0.23, 0.25, 0.25], yaw);
    drawFlag(-0.52, -0.42, 1.55);
  };

  WebGLWorld.prototype.drawAgent = function drawDetailedAgent(agent, now) {
    const center = this.agentPosition(agent, now);
    const ground = [center[0], center[1] - 0.62, center[2]];
    const faction = this.state.factions.find((entry) => entry.id === agent.factionId);
    const factionColor = hexColor(faction?.color);
    const taskTarget = agent.task?.target;
    const yaw = taskTarget ? Math.atan2(taskTarget.x - agent.position.x, taskTarget.y - agent.position.y) : 0;
    const moving = Boolean(taskTarget) || /moving|travel|gather|haul/i.test(agent.status || "");
    const phase = now * 0.008 + detailHash(agent.position.x, agent.position.y, agent.id.length) * Math.PI * 2;
    const stride = moving ? Math.sin(phase) * 0.11 : Math.sin(phase * 0.25) * 0.012;
    const bob = moving ? Math.abs(Math.sin(phase)) * 0.035 : Math.sin(phase * 0.2) * 0.008;
    const skin = [0.82, 0.68, 0.54];
    const trousers = detailShade(factionColor, 0.48);
    const leather = [0.28, 0.19, 0.11];

    this.draw(this.meshes.sphere, [ground[0], ground[1] + 0.025, ground[2]], [0.38, 0.035, 0.27], [0.025, 0.045, 0.03], yaw, 0.42);
    if (agent.id === this.selectedAgentId) {
      this.draw(this.meshes.torus, [ground[0], ground[1] + 0.055, ground[2]], [1, 1, 1], [0.78, 1, 0.4], 0, 0.92);
    }

    for (const side of [-1, 1]) {
      const legZ = side * stride;
      this.draw(this.meshes.box, detailOffset(ground, side * 0.105, 0.29 + bob, legZ, yaw), [0.12, 0.44, 0.13], trousers, yaw);
      this.draw(this.meshes.box, detailOffset(ground, side * 0.105, 0.085, legZ + 0.035, yaw), [0.145, 0.13, 0.22], leather, yaw);
    }

    this.draw(this.meshes.box, detailOffset(ground, 0, 0.69 + bob, 0, yaw), [0.43, 0.52, 0.28], factionColor, yaw);
    this.draw(this.meshes.box, detailOffset(ground, 0, 0.58 + bob, 0.145, yaw), [0.45, 0.075, 0.3], leather, yaw);
    this.draw(this.meshes.box, detailOffset(ground, 0, 0.89 + bob, -0.16, yaw), [0.31, 0.34, 0.12], detailShade(factionColor, 0.72), yaw);

    for (const side of [-1, 1]) {
      const armSwing = -side * stride * 0.65;
      this.draw(this.meshes.box, detailOffset(ground, side * 0.28, 0.7 + bob, armSwing, yaw), [0.1, 0.42, 0.11], detailShade(factionColor, 0.87), yaw);
      this.draw(this.meshes.sphere, detailOffset(ground, side * 0.28, 0.46 + bob, armSwing + 0.01, yaw), [0.13, 0.13, 0.13], skin, yaw);
    }

    this.draw(this.meshes.cylinder, detailOffset(ground, 0, 1.08 + bob, 0, yaw), [0.105, 0.13, 0.105], skin, yaw);
    this.draw(this.meshes.sphere, detailOffset(ground, 0, 1.25 + bob, 0, yaw), [0.27, 0.29, 0.25], skin, yaw);
    this.draw(this.meshes.sphere, detailOffset(ground, 0, 1.32 + bob, -0.02, yaw), [0.275, 0.16, 0.255], [0.19, 0.14, 0.1], yaw);

    const roleColor = agent.role === "builder" ? [0.95, 0.72, 0.17]
      : agent.role === "miner" ? [0.58, 0.66, 0.72]
        : agent.role === "woodcutter" ? [0.32, 0.52, 0.23]
          : agent.role === "trader" ? [0.56, 0.31, 0.63]
            : [0.78, 0.43, 0.2];

    if (agent.role === "builder" || agent.role === "miner") {
      this.draw(this.meshes.sphere, detailOffset(ground, 0, 1.39 + bob, 0, yaw), [0.31, 0.15, 0.29], roleColor, yaw);
      this.draw(this.meshes.box, detailOffset(ground, 0, 1.34 + bob, 0.11, yaw), [0.37, 0.035, 0.2], roleColor, yaw);
      if (agent.role === "miner") this.draw(this.meshes.sphere, detailOffset(ground, 0, 1.39 + bob, 0.25, yaw), [0.075, 0.075, 0.055], [0.95, 0.9, 0.58], yaw);
    } else {
      this.draw(this.meshes.box, detailOffset(ground, 0, 1.4 + bob, 0, yaw), [0.34, 0.1, 0.31], roleColor, yaw);
    }

    const toolBase = detailOffset(ground, 0.38, 0.66 + bob, 0.08, yaw);
    if (agent.role === "builder") {
      this.draw(this.meshes.box, toolBase, [0.48, 0.045, 0.045], [0.38, 0.23, 0.11], yaw);
      this.draw(this.meshes.box, detailOffset(ground, 0.62, 0.66 + bob, 0.08, yaw), [0.16, 0.16, 0.1], [0.32, 0.34, 0.34], yaw);
    } else if (agent.role === "miner") {
      this.draw(this.meshes.box, toolBase, [0.56, 0.04, 0.04], [0.35, 0.23, 0.12], yaw);
      this.draw(this.meshes.box, detailOffset(ground, 0.64, 0.66 + bob, 0.08, yaw), [0.12, 0.055, 0.35], [0.4, 0.44, 0.46], yaw);
    } else if (agent.role === "woodcutter") {
      this.draw(this.meshes.box, toolBase, [0.48, 0.045, 0.045], [0.34, 0.21, 0.1], yaw);
      this.draw(this.meshes.box, detailOffset(ground, 0.61, 0.66 + bob, 0.08, yaw), [0.12, 0.2, 0.06], [0.48, 0.51, 0.5], yaw);
    } else if (agent.role === "forager") {
      this.draw(this.meshes.cylinder, detailOffset(ground, 0.32, 0.55 + bob, 0.02, yaw), [0.19, 0.28, 0.19], [0.52, 0.32, 0.14], yaw);
    }
  };

  WebGLWorld.prototype.frame = function frameDetailed(now) {
    this.resize();
    const gl = this.gl;
    gl.clearColor(0.052, 0.102, 0.105, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    const { eye } = this.cameraVectors();
    gl.uniformMatrix4fv(this.locations.projection, false, mat4Perspective(this.fov, this.canvas.width / this.canvas.height, 0.1, 160));
    gl.uniformMatrix4fv(this.locations.view, false, mat4LookAt(eye, this.camera.target, [0, 1, 0]));
    if (this.state && this.terrainMesh) {
      this.draw(this.meshes.box, [0, -0.62, 0], [this.state.width + 0.28, 0.76, this.state.height + 0.28], [0.065, 0.105, 0.075]);
      this.draw(this.terrainMesh, [0, 0, 0], [1, 1, 1], [1, 1, 1]);
      if (this.waterMesh) {
        gl.depthMask(false);
        const shimmer = 0.94 + Math.sin(now * 0.0011) * 0.045;
        this.draw(this.waterMesh, [0, 0, 0], [1, 1, 1], [0.82 * shimmer, 0.94 * shimmer, 1], 0, 0.57);
        gl.depthMask(true);
      }
      for (const tile of this.state.tiles) {
        this.drawGroundDetail(tile);
        this.drawResource(tile);
      }
      for (const structure of this.state.structures) this.drawStructure(structure);
      for (const agent of this.state.agents) this.drawAgent(agent, now);
    }
    requestAnimationFrame((time) => this.frame(time));
  };

  renderer.meshes.cylinder = renderer.createMesh(detailCylinderGeometry(12));
  renderer.meshes.cone = renderer.createMesh(detailCylinderGeometry(12, 0, 0.5));
  renderer.meshes.sphere = renderer.createMesh(detailSphereGeometry(7, 10));
  renderer.meshes.torus = renderer.createMesh(detailTorusGeometry());
  renderer.meshes.gable = renderer.createMesh(detailGableGeometry());

  const clampCameraTarget = () => {
    if (!renderer.state) return;
    const halfWidth = Math.max(2, renderer.state.width / 2 - 0.5);
    const halfHeight = Math.max(2, renderer.state.height / 2 - 0.5);
    renderer.camera.target[0] = clamp(renderer.camera.target[0], -halfWidth, halfWidth);
    renderer.camera.target[2] = clamp(renderer.camera.target[2], -halfHeight, halfHeight);
  };

  const middlePan = { active: false, pointerId: null, x: 0, y: 0 };
  renderer.canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    middlePan.active = true;
    middlePan.pointerId = event.pointerId;
    middlePan.x = event.clientX;
    middlePan.y = event.clientY;
    renderer.canvas.style.cursor = "grabbing";
  });
  renderer.canvas.addEventListener("pointermove", (event) => {
    if (!middlePan.active || event.pointerId !== middlePan.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - middlePan.x;
    const dy = event.clientY - middlePan.y;
    middlePan.x = event.clientX;
    middlePan.y = event.clientY;
    const amount = Math.max(0.0035, renderer.camera.distance * 0.00215);
    const localX = dx * amount;
    const localZ = dy * amount;
    const c = Math.cos(renderer.camera.yaw), s = Math.sin(renderer.camera.yaw);
    renderer.camera.target[0] += localX * c + localZ * s;
    renderer.camera.target[2] += -localX * s + localZ * c;
    clampCameraTarget();
  });
  const stopMiddlePan = (event) => {
    if (!middlePan.active || (event.pointerId !== undefined && event.pointerId !== middlePan.pointerId)) return;
    middlePan.active = false;
    middlePan.pointerId = null;
    renderer.canvas.style.cursor = "default";
  };
  renderer.canvas.addEventListener("pointerup", stopMiddlePan);
  renderer.canvas.addEventListener("pointercancel", stopMiddlePan);
  renderer.canvas.addEventListener("lostpointercapture", stopMiddlePan);
  renderer.canvas.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });
  renderer.canvas.addEventListener("mousedown", (event) => {
    if (event.button === 1) event.preventDefault();
  });

  const originalFocusAgent = WebGLWorld.prototype.focusAgent;
  WebGLWorld.prototype.focusAgent = function focusDetailedAgent(agentId) {
    originalFocusAgent.call(this, agentId);
    clampCameraTarget();
  };

  if (renderer.state) {
    renderer.buildTerrain(renderer.state);
  }
})();
