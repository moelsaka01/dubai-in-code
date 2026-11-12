// Burj Khalifa (828 m). Y-shaped plan: three wings at 120 degrees around a core. 27 setbacks climb in a
// spiral, each one shortening the next wing; every height band is the outline of core + current wings,
// extruded. Above the wings the core steps in three more times and a telescoping spire runs to 828 m.
// Local frame: base at y = 0, wing 0 points along +x.
import * as THREE from 'three';
import { GeoBuilder, landmarkMaterial } from './common.js';

const WING_TOP = 600; // last wing setback
const BASE_LEN = 80; // wing tip distance from the centre at ground level
const SETBACKS = 27;
const NOSE_SEGMENTS = 8;
const lerp = (a, b, t) => a + (b - a) * t;

/** Outline of core + three wings. len[i] = nose tip distance of wing i, w = wing width, rc = notch radius. */
function outline(len, w, rc) {
  const pts = [];
  const rn = Math.max(rc, w / Math.sqrt(3)); // where two neighbouring wing sides meet
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3;
    pts.push([rn * Math.cos(a - Math.PI / 3), rn * Math.sin(a - Math.PI / 3)]);
    const c = len[i] - w / 2; // centre of the rounded nose
    if (c > rn * 0.9) {
      for (let s = 0; s <= NOSE_SEGMENTS; s++) {
        const b = a - Math.PI / 2 + (s / NOSE_SEGMENTS) * Math.PI;
        pts.push([c * Math.cos(a) + (w / 2) * Math.cos(b), c * Math.sin(a) + (w / 2) * Math.sin(b)]);
      }
    } else {
      const r = Math.max(len[i], rn);
      pts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
  }
  return pts;
}

function circle(r, n = 12) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI)]);
  return pts;
}

export function create(env) {
  const gb = new GeoBuilder();
  const len = [BASE_LEN, BASE_LEN, BASE_LEN];
  const cuts = [0, 0, 0];
  let y0 = 0;
  for (let b = 0; b <= SETBACKS; b++) {
    // Setback heights: evenly spread at first, slightly closer together toward the top.
    const y1 = b < SETBACKS ? 46 + (WING_TOP - 46) * Math.pow(b / (SETBACKS - 1), 0.92) : 636;
    const f = Math.min(1, (y0 + y1) / 2 / WING_TOP);
    gb.prism(outline(len, lerp(27, 15, f), lerp(20, 11.5, f)), y0, y1);
    if (b < SETBACKS) {
      const wing = b % 3;
      cuts[wing]++;
      len[wing] = lerp(BASE_LEN, 14, Math.pow(cuts[wing] / 9, 0.9));
    }
    y0 = y1;
  }
  // Upper core, then the spire.
  const stages = [[672, 9.5], [704, 7.5], [730, 5.5], [768, 3.4], [800, 2.2], [824, 1.2], [828, 0.45]];
  for (const [y1, r] of stages) {
    gb.prism(circle(r), y0, y1);
    y0 = y1;
  }

  const material = landmarkMaterial(env, {
    body: /* glsl */ `
      if (n.y > 0.5) {
        albedo = vec3(0.40, 0.42, 0.44);
        gloss = 0.1;
      } else {
        float y = vUv.y;
        vec2 g = vec2(vUv.x / 1.5, y / 3.8);
        vec2 fw = fwidth(g);
        float detail = 1.0 - smoothstep(0.3, 0.8, max(fw.x, fw.y));
        float fin = smoothstep(0.34, 0.46, abs(fract(g.x) - 0.5));  // fine vertical steel fins
        float band = smoothstep(0.36, 0.46, abs(fract(g.y) - 0.5)); // spandrels
        float frame = mix(0.3, max(fin * 0.8, band * 0.55), detail);
        vec3 glass = vec3(0.09, 0.14, 0.19);
        vec3 steel = vec3(0.60, 0.63, 0.66);
        float spire = smoothstep(700.0, 735.0, y);
        albedo = mix(mix(glass, steel, frame), steel, spire);
        gloss = mix(mix(0.9, 0.35, frame), 0.5, spire);
        metal = 0.5 * (1.0 - frame); // coated glass: it mirrors the sky at every angle, which is what makes the tower silver-blue

        vec2 cell = floor(g);
        float share = uLitFraction * 0.35;
        float lit = mix(share * 0.35, step(hash21(cell + 3.0), share), detail);
        float sparkle = mix(0.008, step(0.992, hash21(cell * 0.73 + floor(uTime * 4.0) * 7.0)), detail);
        // After dark the tower is not floodlit evenly: it is dim at the foot, brighter toward the top, banded by
        // its mechanical floors, with scattered lit rooms and the LED sparkle running over it.
        float rise = 0.35 + 0.65 * smoothstep(0.0, 620.0, y);
        float bandGlow = 0.7 + 0.5 * step(0.86, fract(y / 104.0));
        vec3 e = vec3(0.80, 0.90, 1.0) * (0.035 * rise * bandGlow + 0.9 * lit * (1.0 - frame)) + vec3(2.5) * sparkle;
        emissive = mix(e, vec3(0.9, 0.95, 1.0) * 0.6, spire) * uNight;
      }
    `,
  });

  const group = new THREE.Group();
  group.add(new THREE.Mesh(gb.build(), material));
  return { group, beacons: [[0, 831, 0]], update() {} };
}
