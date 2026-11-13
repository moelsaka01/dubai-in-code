// Burj Al Arab (321 m). A loft of 40 slices x 24 section points. The section is a wedge: two wings that
// spread from the mast, closed at the front by the white fabric wall. How far the wings reach follows a
// sail curve, so the side view is the famous bow. Plus: mast, two exoskeleton arcs along the bow, the
// helipad on its cantilever and the sky-bar crossing behind the mast.
// Local frame: mast at the origin, +x toward the fabric front (the shore side), base at y = 0.
import * as THREE from 'three';
import { GeoBuilder, landmarkMaterial, strut } from './common.js';

const BODY_TOP = 200;
const MAST_TOP = 321;
const SLICES = 40;
const SPREAD = 0.41; // half-width of the front per metre of depth (the OSM footprint is 77 m wide at 94 m depth)
const U_STRUCTURE = 5000; // uv.x marker for steelwork

/** Distance from the mast to the wing tips at height fraction s: a Bezier that bulges low and tapers to the mast. */
function depth(s) {
  if (s > 1) return Math.max(1.5, 8 * (1 - (s - 1) / 0.16));
  const t = 1 - s;
  return t * t * t * 95 + 3 * t * t * s * 105 + 3 * t * s * s * 80 + s * s * s * 8;
}

/** 24 points, counter-clockwise in plan: fabric front (7), left wing side (8), mast (1), right wing side (8). */
function section(y) {
  const d = depth(y / BODY_TOP), w = d * SPREAD;
  const pts = [], us = [];
  for (let k = 0; k <= 6; k++) {
    const f = k / 6;
    pts.push([d + 0.16 * d * Math.sin(Math.PI * f), y, -w + 2 * w * f]);
    us.push(f * 0.999); // uv.x < 1 marks the fabric
  }
  const back = Math.min(5, w * 0.6);
  const side = (from, to, flip) => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const nx = (to[1] - from[1]) / len, nn = -(to[0] - from[0]) / len; // right of travel = outward
    for (let k = 0; k <= 7; k++) {
      const f = k / 7, bulge = 0.05 * len * Math.sin(Math.PI * f);
      pts.push([from[0] + (to[0] - from[0]) * f + nx * bulge, y, from[1] + (to[1] - from[1]) * f + nn * bulge]);
      us.push(2 + (flip ? 1 - f : f) * len + (flip ? 200 : 0));
    }
  };
  side([d, w], [1.5, back], false);
  pts.push([-2.5, y, 0]);
  us.push(150);
  side([1.5, -back], [d, -w], true);
  return { pts, us };
}

export function create(env) {
  const gb = new GeoBuilder();
  const rings = [];
  let us = null;
  for (let i = 0; i < SLICES; i++) {
    const s = section((i / (SLICES - 1)) * BODY_TOP);
    rings.push(s.pts);
    if (!us) us = s.us;
  }
  // Hard edges where the fabric meets the wings (columns 6|7) and at the right tip (the strip is left open there).
  gb.loft(rings, { skip: new Set([6]), us });
  const top = rings[SLICES - 1].map((p) => [p[0], p[2]]);
  gb.prism(top, BODY_TOP - 0.05, BODY_TOP + 2);

  const addStruct = (g, m = null) => { gb.add(g, m, U_STRUCTURE); g.dispose(); };
  addStruct(strut([0, 0, 0], [0, BODY_TOP + 30, 0], 3.2, 2.4, 10));
  addStruct(strut([0, BODY_TOP + 30, 0], [0, MAST_TOP, 0], 2.4, 0.5, 8));
  // Exoskeleton arcs: follow the wing tips up the bow and close onto the mast above the roof.
  for (const sz of [-1, 1]) {
    const curve = [];
    for (let k = 0; k <= 26; k++) {
      const y = (k / 26) * BODY_TOP * 1.15;
      const d = depth(y / BODY_TOP);
      curve.push(new THREE.Vector3(d + 2.5, y, sz * (d * SPREAD + 2.5)));
    }
    addStruct(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(curve), 48, 2.1, 6, false));
  }
  // Helipad on the shore side, sky-bar across the back of the mast.
  const padX = depth(0.96) + 17;
  addStruct(new THREE.CylinderGeometry(12, 11, 1.4, 24), new THREE.Matrix4().makeTranslation(padX, 207, 0));
  addStruct(strut([2, 196, 0], [padX - 4, 205.5, 0], 2.0, 1.4, 6));
  addStruct(new THREE.BoxGeometry(11, 7, 62), new THREE.Matrix4().makeTranslation(-9, 193, 0));

  const material = landmarkMaterial(env, {
    body: /* glsl */ `
      float y = vLocal.y;
      if (vUv.x > 4000.0) {
        // White steelwork, floodlit at night.
        albedo = vec3(0.86, 0.87, 0.88);
        gloss = 0.1;
        emissive = vec3(0.75, 0.80, 0.90) * 0.22 * uNight;
      } else if (n.y > 0.5) {
        albedo = vec3(0.55);
      } else if (vUv.x < 1.0) {
        // Fabric wall: white panels, colour-cycling wash after dark.
        float seam = smoothstep(0.44, 0.49, abs(fract(y / 16.6) - 0.5)) + smoothstep(0.46, 0.49, abs(fract(vUv.x * 2.0) - 0.5));
        albedo = vec3(0.90, 0.90, 0.88) * (1.0 - 0.25 * min(seam, 1.0));
        gloss = 0.08;
        vec3 hue = 0.5 + 0.5 * cos(6.2832 * (uTime * 0.03 + y / 600.0 + vec3(0.0, 0.33, 0.67)));
        emissive = hue * (0.55 + 0.3 * sin(y / 23.0 + uTime * 0.4)) * uNight;
      } else {
        // Wing sides: blue glass between white floor bands.
        vec2 g = vec2(vUv.x / 4.0, y / 7.0);
        vec2 fw = fwidth(g);
        float detail = 1.0 - smoothstep(0.3, 0.8, max(fw.x, fw.y));
        float band = smoothstep(0.30, 0.40, abs(fract(g.y) - 0.5));
        float post = smoothstep(0.40, 0.46, abs(fract(g.x) - 0.5));
        float frame = mix(0.4, max(band, post * 0.7), detail);
        albedo = mix(vec3(0.07, 0.16, 0.26), vec3(0.88, 0.89, 0.90), frame);
        gloss = mix(0.85, 0.1, frame);
        skyward = 1.0;
        // Suites are two floors high and several bays wide, so light comes in runs here too.
        vec2 cell = floor(g);
        float share = uLitFraction * 0.6;
        float hr = hash21(vec2(floor((cell.x + floor(hash11(cell.y * 3.7) * 3.0)) / 3.0), cell.y) + 5.0);
        float tone = fract(hr * 17.3);
        float lit = mix(share * 0.4, step(hr, share) * (0.2 + 0.8 * tone * tone), detail);
        emissive = (mix(vec3(1.0, 0.54, 0.22), vec3(1.0, 0.80, 0.52), tone) * lit * (1.0 - frame) * 0.8 + vec3(0.10, 0.12, 0.16) * frame) * uNight;
      }
    `,
  });

  const group = new THREE.Group();
  group.add(new THREE.Mesh(gb.build(), material));
  return { group, beacons: [[0, MAST_TOP + 3, 0]], update() {} };
}
