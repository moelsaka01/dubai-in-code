// Street life: palms along the roads and in gardens, shade trees in parks, cars on the streets, boats on the
// water. None of it is on the map as objects; the tile worker decides where things go from roads, villas and
// parks, and this module draws them as instanced meshes, one per kind per 2 km cell, shown only near the camera.
import * as THREE from 'three';
import { BBOX, project } from '../shared/config.js';
import { GeoBuilder, landmarkMaterial } from '../landmarks/common.js';

const CELL = 2000, HALF = 12000;
const GROUND_Y = 1.5, ROAD_Y = 1.64;
const FAR = { palms: 1900, trees: 1900, cars: 1000, boats: 6000 }; // metres from the edge of a cell
const BOATS = 520;

function palmGeometry() {
  const gb = new GeoBuilder();
  // Kept to 36 triangles: there are tens of thousands of these.
  const trunk = new THREE.CylinderGeometry(0.22, 0.34, 8.2, 4, 1, true);
  gb.add(trunk, new THREE.Matrix4().makeTranslation(0, 4.1, 0), 0);
  trunk.dispose();
  const top = [0, 8.2, 0];
  const R = [0.2, 2.2, 4.2], Y = [0.3, 0.9, -0.8], W = [0.25, 0.7, 0.08];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + (i % 2) * 0.3, lift = (i % 3) * 0.35;
    const dx = Math.cos(a), dz = Math.sin(a);
    const base = gb.count;
    for (let k = 0; k < 3; k++) {
      const x = top[0] + dx * R[k], y = top[1] + Y[k] + lift * (1 - k / 2), z = top[2] + dz * R[k];
      // Fronds droop, so the normal leans outward more toward the tip.
      const ny = 1 - k * 0.3, nh = k * 0.4;
      const l = Math.hypot(ny, nh);
      for (const s of [-1, 1]) gb.vert(x - dz * W[k] * s, y, z + dx * W[k] * s, (dx * nh) / l, ny / l, (dz * nh) / l, 1, k / 2);
    }
    for (let k = 0; k < 2; k++) {
      const p = base + k * 2;
      gb.i.push(p, p + 1, p + 3, p, p + 3, p + 2);
    }
  }
  return gb.build();
}

function treeGeometry() {
  const gb = new GeoBuilder();
  const trunk = new THREE.CylinderGeometry(0.2, 0.3, 3.4, 4, 1, true);
  gb.add(trunk, new THREE.Matrix4().makeTranslation(0, 1.7, 0), 0);
  trunk.dispose();
  for (const [x, y, z, r] of [[0.3, 5.1, 0, 3.0], [-1.4, 4.4, -0.9, 2.2]]) {
    const ball = new THREE.IcosahedronGeometry(1, 0);
    ball.setAttribute('normal', ball.getAttribute('position').clone()); // smooth: the facets of a 20-face ball would show
    gb.add(ball, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(r, r * 0.78, r)), 1);
    ball.dispose();
  }
  return gb.build();
}

/** A saloon-sized car, nose along +x, wheels on y = 0. */
export function carGeometry() {
  const gb = new GeoBuilder();
  const body = new THREE.BoxGeometry(4.4, 0.72, 1.8);
  gb.add(body, new THREE.Matrix4().makeTranslation(0, 0.62, 0), 0);
  body.dispose();
  const cabin = new THREE.BoxGeometry(2.3, 0.58, 1.58);
  gb.add(cabin, new THREE.Matrix4().makeTranslation(-0.25, 1.27, 0), 1);
  cabin.dispose();
  return gb.build();
}

function boatGeometry() {
  const gb = new GeoBuilder();
  gb.prism([[7, 0], [4, 1.9], [-6, 2.0], [-6.6, 1.3], [-6.6, -1.3], [-6, -2.0], [4, -1.9]], 0.0, 1.5);
  gb.prism([[2.2, 1.2], [-3.4, 1.35], [-3.4, -1.35], [2.2, -1.2]], 1.5, 2.9);
  gb.prism([[0.4, 0.9], [-2.4, 1.0], [-2.4, -1.0], [0.4, -0.9]], 2.9, 3.9);
  return gb.build();
}

export function carMaterial(env) {
  return landmarkMaterial(env, {
    body: /* glsl */ `
      float pick = hash21(floor(vOrigin.xz * 3.0));
      vec3 paint = vec3(0.82, 0.82, 0.80);                       // white, the Gulf's favourite
      paint = mix(paint, vec3(0.50, 0.52, 0.54), step(0.42, pick)); // silver
      paint = mix(paint, vec3(0.05, 0.05, 0.06), step(0.64, pick)); // black
      paint = mix(paint, vec3(0.24, 0.25, 0.27), step(0.80, pick)); // grey
      paint = mix(paint, vec3(0.40, 0.05, 0.04), step(0.92, pick)); // red
      paint = mix(paint, vec3(0.06, 0.12, 0.30), step(0.96, pick)); // blue
      float glassy = step(0.5, vUv.x) * (1.0 - step(0.5, n.y));     // cabin sides are windows, its top is roof
      albedo = mix(paint, vec3(0.03, 0.04, 0.05), glassy);
      gloss = mix(0.45, 0.85, glassy);
      // After dark: headlights on the nose, tail lights on the back. Two cars in five are parked with lights off.
      float on = step(0.4, hash21(floor(vOrigin.xz * 1.7) + 9.0)) * step(vLocal.y, 1.0) * uNight;
      emissive = (vec3(1.0, 0.95, 0.80) * step(2.12, vLocal.x) * 1.8 + vec3(1.0, 0.06, 0.03) * step(vLocal.x, -2.12) * 1.3) * on;
    `,
  });
}

export function createProps(env) {
  const group = new THREE.Group();
  const vegetation = landmarkMaterial(env, {
    side: THREE.DoubleSide,
    body: /* glsl */ `
      float leaf = step(0.5, vUv.x);
      float tone = hash21(floor(vOrigin.xz * 0.5));
      vec3 green = mix(vec3(0.07, 0.15, 0.04), vec3(0.17, 0.27, 0.08), tone);
      green *= 0.75 + 0.5 * smoothstep(0.0, 9.0, vLocal.y);       // lighter where it catches the sky
      albedo = mix(vec3(0.22, 0.18, 0.13), green, leaf);
      emissive = albedo * vec3(1.0, 0.7, 0.4) * 0.05 * uNight;
    `,
  });
  const boatMaterial = landmarkMaterial(env, {
    body: /* glsl */ `
      albedo = vec3(0.86, 0.86, 0.84);
      albedo = mix(albedo, vec3(0.05, 0.10, 0.20), step(vLocal.y, 0.5));                    // dark waterline
      albedo = mix(albedo, vec3(0.03, 0.04, 0.05), step(1.9, vLocal.y) * step(vLocal.y, 2.6) * (1.0 - step(0.5, n.y))); // cabin glass
      gloss = 0.35;
      emissive = vec3(1.0, 0.8, 0.5) * 0.25 * uNight * step(1.9, vLocal.y) * step(vLocal.y, 2.6) * step(0.6, hash21(floor(vOrigin.xz)));
    `,
  });
  const kinds = {
    palms: { geometry: palmGeometry(), material: vegetation, y: GROUND_Y, cells: new Map() },
    trees: { geometry: treeGeometry(), material: vegetation, y: GROUND_Y, cells: new Map() },
    cars: { geometry: carGeometry(), material: carMaterial(env), y: ROAD_Y, cells: new Map() },
    boats: { geometry: boatGeometry(), material: boatMaterial, y: 0, cells: new Map() },
  };
  const meshes = [];
  const counts = { palms: 0, trees: 0, cars: 0, boats: 0 };
  const centre = new THREE.Vector3();

  function add(kind, items) {
    const cells = kinds[kind].cells;
    for (let i = 0; i + 3 < items.length; i += 4) {
      const key = `${Math.floor((items[i] + HALF) / CELL)}_${Math.floor((items[i + 1] + HALF) / CELL)}`;
      let list = cells.get(key);
      if (!list) cells.set(key, (list = []));
      list.push(items[i], items[i + 1], items[i + 2], items[i + 3]);
    }
  }

  return {
    object: group,
    counts,
    /** Items from the worker: { palms, trees, cars }, each a flat list of (x, z, size, heading). */
    add(props) {
      for (const kind of ['palms', 'trees', 'cars']) if (props[kind] && props[kind].length) add(kind, props[kind]);
    },
    /**
     * Moor boats where the city map says there is water close to a shore.
     * @param {{ data: Uint8Array, size: number }} mask r: land, g: blurred land (0..255), row 0 = south
     */
    addBoats(mask) {
      let seed = 987654321;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const zones = ['marina', 'palm', 'baa'].map((k) => {
        const [s, w, n, e] = BBOX[k];
        const a = project(s, w), b = project(n, e);
        return [a[0], a[1], b[0], b[1]];
      });
      const out = [];
      for (let tries = 0; tries < 60000 && out.length < BOATS * 4; tries++) {
        const z = zones[Math.floor(rnd() * zones.length)];
        const east = z[0] + rnd() * (z[2] - z[0]), north = z[1] + rnd() * (z[3] - z[1]);
        const i = Math.floor((east / (2 * HALF) + 0.5) * mask.size), j = Math.floor((north / (2 * HALF) + 0.5) * mask.size);
        if (i < 0 || j < 0 || i >= mask.size || j >= mask.size) continue;
        const p = (j * mask.size + i) * 4;
        if (mask.data[p] > 6 || mask.data[p + 1] < 46 || mask.data[p + 1] > 235) continue; // water, 30 to 250 m from land
        out.push(east, -north, 0.6 + rnd() * rnd() * 1.6, rnd() * 6.283);
      }
      add('boats', out);
    },
    /** Turn everything collected so far into instanced meshes. Call once, after the city has loaded. */
    build() {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      const p = new THREE.Vector3(), s = new THREE.Vector3();
      for (const [kind, k] of Object.entries(kinds)) {
        for (const [key, list] of k.cells) {
          const n = list.length / 4;
          const mesh = new THREE.InstancedMesh(k.geometry, k.material, n);
          for (let i = 0; i < n; i++) {
            const size = list[4 * i + 2];
            q.setFromAxisAngle(up, list[4 * i + 3]);
            m.compose(p.set(list[4 * i], k.y, list[4 * i + 1]), q, s.set(size, size, size));
            mesh.setMatrixAt(i, m);
          }
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingSphere();
          mesh.visible = false;
          group.add(mesh);
          const [cx, cz] = key.split('_').map(Number);
          meshes.push({ mesh, casts: kind === 'palms' || kind === 'trees', far: FAR[kind], centre: new THREE.Vector3((cx + 0.5) * CELL - HALF, 0, (cz + 0.5) * CELL - HALF) });
          counts[kind] += n;
        }
        k.cells.clear();
      }
    },
    /** For the shadow pass: leave only palms and trees visible. The next update() puts everything back. */
    castOnly() {
      for (const t of meshes) if (!t.casts) t.mesh.visible = false;
    },
    /** @param {number} reach multiplier on the draw distances (Low quality draws nearer) */
    update(camera, reach = 1) {
      for (const t of meshes) t.mesh.visible = centre.copy(t.centre).sub(camera.position).length() - CELL * 0.71 < t.far * reach;
    },
  };
}
