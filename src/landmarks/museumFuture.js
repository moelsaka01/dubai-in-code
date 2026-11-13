// Museum of the Future (77 m). A parametric surface: an ellipse standing upright is the centre curve, and an
// elliptical cross-section is swept around it: thick and deep at the base, slim at the top, leaning slightly,
// so the void sits high and off-centre. It rests on a green mound.
// The skin is polished steel that mirrors sky and city, cut by rows of script-like windows: each row is a
// line of text built from strokes (a base line, uprights, bowls, tails, dots) picked per letter by a hash.
// Dark glass by day, lit white at night.
// Local frame: the ring stands in the XY plane, long axis along x, base at y = 0.
import * as THREE from 'three';
import { GeoBuilder, landmarkMaterial } from './common.js';

const A = 35, B = 23.5; // semi-axes of the centre curve
const MOUND_H = 14;
const CENTRE_Y = MOUND_H + 14 + B - 6; // the ring sinks 6 m into the mound
const LEAN = 0.1; // metres sideways per metre of height
const NU = 128, NV = 36;
const ROWS = 8, LETTERS = 34;

export function create(env) {
  const centre = (phi) => [A * Math.cos(phi), CENTRE_Y + B * Math.sin(phi)];
  const ring = new GeoBuilder();
  ring.grid(NU, NV, (u, v) => {
    // The u seam sits at the bottom of the ring, inside the mound.
    const phi = -Math.PI / 2 + u * 2 * Math.PI, theta = v * 2 * Math.PI;
    const c = Math.cos(phi), s = Math.sin(phi);
    const nl = Math.hypot(B * c, A * s);
    const nx = (B * c) / nl, ny = (A * s) / nl; // outward normal of the centre ellipse
    const r1 = 11 - 3 * s + c * c + 0.8 * c; // in-plane radius: 14 at the base, 8 at the top, ~12 at the ends
    const r2 = 15 - 4 * s; // half-depth: 19 at the base, 11 at the top
    const [cx, cy] = centre(phi);
    const y = cy + ny * r1 * Math.cos(theta);
    return [cx + nx * r1 * Math.cos(theta) + LEAN * (y - CENTRE_Y), y, r2 * Math.sin(theta)];
  }, {
    wrapU: true,
    wrapV: true,
    outward: (p) => {
      // Away from the nearest point of the centre curve (approximated by the same polar angle).
      const phi = Math.atan2((p[1] - CENTRE_Y) / B, (p[0] - LEAN * (p[1] - CENTRE_Y)) / A);
      const [cx, cy] = centre(phi);
      return [p[0] - LEAN * (p[1] - CENTRE_Y) - cx, p[1] - cy, p[2]];
    },
  });

  const steel = landmarkMaterial(env, {
    body: /* glsl */ `
      float ph = vUv.x, th = vUv.y;
      // Rows of text run around the tube and drift as they go, like the real inscription.
      float rc = th * ${ROWS.toFixed(1)} + 0.45 * sin(ph * 12.5664 + th * 6.2832);
      float row = floor(rc), ry = fract(rc);
      float sx = ph * ${LETTERS.toFixed(1)} + hash11(row * 7.7) * 13.0;
      vec2 letter = vec2(floor(sx), row);
      float fx = fract(sx);
      float hA = hash21(letter), hB = hash21(letter + 17.3), hC = hash21(letter + 41.9);
      float aaY = fwidth(rc) * 1.2 + 0.008, aaX = fwidth(sx) * 1.2 + 0.008;
      float detail = 1.0 - smoothstep(0.12, 0.45, max(aaY, aaX * 0.6));

      float yb = 0.34 + 0.05 * sin(sx * 3.1 + row);                                  // the line the letters sit on
      float base = (1.0 - smoothstep(0.065, 0.065 + aaY, abs(ry - yb))) * step(0.15, hA);
      float ax = 0.5 + (hB - 0.5) * 0.3 + (ry - yb) * 0.12;
      float upright = (1.0 - smoothstep(0.085, 0.085 + aaX, abs(fx - ax))) * step(yb - 0.02, ry)
        * (1.0 - smoothstep(0.86 - aaY, 0.86, ry)) * step(0.5, hB);
      float bowl = (1.0 - smoothstep(0.05, 0.05 + aaX, abs(length(vec2(fx - 0.5, (ry - yb + 0.02) * 1.6)) - 0.2))) * step(0.62, hC);
      float tail = (1.0 - smoothstep(0.05, 0.05 + aaY, abs(ry - (yb - 0.32 * fx * fx)))) * step(hA, 0.4);
      float dotY = mix(0.66, 0.1, step(0.5, hC));
      float mark = (1.0 - smoothstep(0.06, 0.06 + aaX, abs(fx - 0.5) + abs(ry - dotY) * 1.6)) * step(0.6, hA);
      float word = step(0.16, hash21(vec2(floor(sx / 5.0), row) + 3.3));              // gaps between words
      float glyph = max(max(base, upright), max(bowl, max(tail, mark))) * word;
      glyph = mix(0.24, glyph, detail);

      // Steel panels: fine joints and a faint brushed grain.
      vec2 pg = vec2(ph * ${(LETTERS * 2).toFixed(1)}, th * ${(ROWS * 2).toFixed(1)});
      vec2 pf = abs(fract(pg) - 0.5);
      float seam = (1.0 - smoothstep(0.47, 0.5, max(pf.x, pf.y))) ;
      float grain = 0.94 + 0.12 * vnoise(vec2((vLocal.x + vLocal.y) * 3.0, vLocal.z * 0.3));
      vec3 steelCol = vec3(0.60, 0.61, 0.62) * grain * mix(0.82, 1.0, mix(1.0, seam, detail));
      albedo = mix(steelCol, vec3(0.015, 0.018, 0.022), glyph);
      gloss = mix(0.78, 0.92, glyph);
      metal = 0.55 * (1.0 - glyph); // brushed, not chrome: it keeps a silver body under the reflection
      emissive = (vec3(1.0, 0.96, 0.88) * glyph * 0.8 + vec3(0.025, 0.03, 0.04)) * uNight;
    `,
  });

  const mound = new GeoBuilder();
  mound.grid(56, 10, (u, v) => {
    const a = u * 2 * Math.PI, r = Math.cos((v * Math.PI) / 2);
    return [74 * r * Math.cos(a), MOUND_H * Math.pow(Math.sin((v * Math.PI) / 2), 0.7), 41 * r * Math.sin(a)];
  }, { wrapU: true, outward: () => [0, 1, 0] });
  const grass = landmarkMaterial(env, {
    body: /* glsl */ `
      float patchy = vnoise(vLocal.xz * 0.22) * 0.6 + vnoise(vLocal.xz * 1.3) * 0.4;
      albedo = mix(vec3(0.09, 0.17, 0.05), vec3(0.16, 0.26, 0.08), patchy);
      // Low planting beds step up the slope, and a pale retaining wall rings the foot.
      albedo *= 0.9 + 0.1 * step(0.5, fract(vLocal.y / 2.4));
      albedo = mix(albedo, vec3(0.55, 0.53, 0.48), 1.0 - smoothstep(0.6, 1.0, vLocal.y));
      emissive = albedo * vec3(1.0, 0.7, 0.4) * 0.10 * uNight;
    `,
  });

  const group = new THREE.Group();
  group.add(new THREE.Mesh(ring.build(), steel), new THREE.Mesh(mound.build(), grass));
  return { group, beacons: [], update() {} };
}
