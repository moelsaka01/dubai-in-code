// Cayan Tower (306 m). A loft of 75 rings; each ring is the same chamfered rectangle turned a little more
// than the one below, 90 degrees in total. Vertices are shared between rings, which gives the smooth helix.
// The shader draws slab edges and the columns from the uv, so the columns come out helical for free.
import * as THREE from 'three';
import { GeoBuilder, landmarkMaterial } from './common.js';

const HEIGHT = 306;
const RINGS = 75;
const TWIST = Math.PI / 2;
const HALF_X = 18.5, HALF_N = 15, CHAMFER = 5;

// Corners counter-clockwise in plan, and how many segments each side gets.
const CORNERS = [
  [HALF_X - CHAMFER, -HALF_N], [HALF_X, -HALF_N + CHAMFER], [HALF_X, HALF_N - CHAMFER], [HALF_X - CHAMFER, HALF_N],
  [-HALF_X + CHAMFER, HALF_N], [-HALF_X, HALF_N - CHAMFER], [-HALF_X, -HALF_N + CHAMFER], [-HALF_X + CHAMFER, -HALF_N],
];
const SEGMENTS = [1, 2, 1, 3, 1, 2, 1, 3];

export function create(env) {
  // One section: every side lists its own end points, so corners are doubled and stay sharp.
  const section = [], us = [], skip = new Set();
  let u = 0;
  for (let k = 0; k < 8; k++) {
    const a = CORNERS[k], b = CORNERS[(k + 1) % 8], segs = SEGMENTS[k];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let s = 0; s <= segs; s++) {
      section.push([a[0] + ((b[0] - a[0]) * s) / segs, a[1] + ((b[1] - a[1]) * s) / segs]);
      us.push(u + (len * s) / segs);
    }
    u += len;
    if (k < 7) skip.add(section.length - 1); // no quad between this side's last point and the next side's first
  }

  const turn = (p, ang) => [p[0] * Math.cos(ang) - p[1] * Math.sin(ang), p[0] * Math.sin(ang) + p[1] * Math.cos(ang)];
  const rings = [];
  for (let i = 0; i < RINGS; i++) {
    const f = i / (RINGS - 1);
    const ang = (f - 0.5) * TWIST;
    rings.push(section.map((p) => { const q = turn(p, ang); return [q[0], f * HEIGHT, q[1]]; }));
  }

  const gb = new GeoBuilder();
  gb.loft(rings, { skip, us });
  gb.prism(CORNERS.map((p) => turn(p, TWIST / 2)), HEIGHT - 0.05, HEIGHT + 3.5); // flat crown closes the top

  const material = landmarkMaterial(env, {
    body: /* glsl */ `
      if (n.y > 0.5) {
        albedo = vec3(0.45);
      } else {
        vec2 g = vec2(vUv.x / 3.4, vUv.y / ${(HEIGHT / (RINGS - 1)).toFixed(4)});
        vec2 fw = fwidth(g);
        float detail = 1.0 - smoothstep(0.3, 0.8, max(fw.x, fw.y));
        float column = smoothstep(0.36, 0.44, abs(fract(g.x) - 0.5));
        float slab = smoothstep(0.34, 0.44, abs(fract(g.y) - 0.5));
        float frame = mix(0.4, max(column, slab), detail);
        albedo = mix(vec3(0.07, 0.10, 0.13), vec3(0.70, 0.71, 0.70), frame);
        gloss = mix(0.85, 0.15, frame);
        // Night: flats lit in short runs, most of them dim, and a soft cool light on the columns and slab edges
        // so the helix still reads after dark. (A hash per window made a white checkerboard.)
        vec2 cell = floor(g);
        float share = uLitFraction * 0.5;
        float hr = hash21(vec2(floor((cell.x + floor(hash11(cell.y * 3.7) * 3.0)) / 3.0), cell.y) + 9.0);
        float tone = fract(hr * 17.3);
        float lit = mix(share * 0.4, step(hr, share) * (0.15 + 0.85 * tone * tone) * step(0.2, hash21(cell + 4.0)), detail);
        vec3 lamp = mix(vec3(1.0, 0.50, 0.20), vec3(1.0, 0.78, 0.50), tone);
        emissive = (lamp * lit * (1.0 - frame) * 0.75 + vec3(0.036, 0.042, 0.055) * frame + vec3(0.012, 0.015, 0.022)) * uNight;
      }
    `,
  });

  const group = new THREE.Group();
  group.add(new THREE.Mesh(gb.build(), material));
  return { group, beacons: [[0, HEIGHT + 7, 0]], update() {} };
}
