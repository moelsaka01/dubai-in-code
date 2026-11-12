// Museum of the Future (77 m). A parametric surface: an ellipse standing upright is the centre curve, and an
// elliptical cross-section is swept around it, thicker at the base and on one side so the void sits
// off-centre. It rests on a low green mound. The shader draws brushed steel with strokes of glass that read
// as calligraphy and glow at night.
// Local frame: the ring stands in the XY plane, long axis along x, base at y = 0.
import * as THREE from 'three';
import { GeoBuilder, landmarkMaterial } from './common.js';

const A = 38, B = 21.5; // semi-axes of the centre curve
const MOUND_H = 15;
const CENTRE_Y = MOUND_H + 11.5 + B - 2.5; // the ring sinks 2.5 m into the mound
const NU = 96, NV = 28;

export function create(env) {
  const centre = (phi) => [A * Math.cos(phi), CENTRE_Y + B * Math.sin(phi)];
  const ring = new GeoBuilder();
  ring.grid(NU, NV, (u, v) => {
    // The u seam sits at the bottom of the ring, inside the mound.
    const phi = -Math.PI / 2 + u * 2 * Math.PI, theta = v * 2 * Math.PI;
    const c = Math.cos(phi), s = Math.sin(phi);
    const nl = Math.hypot(B * c, A * s);
    const nx = (B * c) / nl, ny = (A * s) / nl; // outward normal of the centre ellipse
    const r1 = 10.5 - s + c + c * c; // in-plane radius: 11.5 bottom, 9.5 top, 12.5 / 10.5 at the two ends
    const r2 = 15 - 3.5 * s; // half-depth: 18.5 bottom, 11.5 top
    const [cx, cy] = centre(phi);
    return [cx + nx * r1 * Math.cos(theta), cy + ny * r1 * Math.cos(theta), r2 * Math.sin(theta)];
  }, {
    wrapU: true,
    wrapV: true,
    outward: (p) => {
      // Away from the nearest point of the centre curve (approximated by the same polar angle).
      const phi = Math.atan2((p[1] - CENTRE_Y) / B, p[0] / A);
      const [cx, cy] = centre(phi);
      return [p[0] - cx, p[1] - cy, p[2]];
    },
  });

  const steel = landmarkMaterial(env, {
    body: /* glsl */ `
      float ph = vUv.x * 6.2832, th = vUv.y * 6.2832;
      float w1 = vnoise(vLocal.xy * 0.11 + vLocal.z * 0.07);
      float w2 = vnoise(vLocal.yx * 0.23 - vLocal.z * 0.05 + 9.0);
      // Seven bands run around the tube, bent by sines and noise, then broken into strokes.
      float bc = vUv.y * 7.0 + 0.6 * sin(ph * 9.0 + w1 * 5.0) + (w1 - 0.5) * 1.2;
      float fw = fwidth(bc);
      float detail = 1.0 - smoothstep(0.25, 0.7, fw);
      float stroke = 1.0 - smoothstep(0.09, 0.17, abs(fract(bc) - 0.5));
      float gaps = smoothstep(0.42, 0.55, w2 + 0.25 * sin(ph * 23.0 + th * 3.0));
      float glyph = mix(0.2, stroke * gaps, detail);
      float brushed = 0.92 + 0.16 * vnoise(vec2((vLocal.x + vLocal.y) * 3.0, vLocal.z * 0.3));
      albedo = mix(vec3(0.56, 0.57, 0.58) * brushed, vec3(0.03, 0.04, 0.05), glyph);
      gloss = mix(0.7, 0.95, glyph);
      emissive = (vec3(1.0, 0.95, 0.86) * glyph * 1.2 + vec3(0.03, 0.035, 0.045)) * uNight;
    `,
  });

  const mound = new GeoBuilder();
  mound.grid(48, 8, (u, v) => {
    const a = u * 2 * Math.PI, r = Math.cos((v * Math.PI) / 2);
    return [78 * r * Math.cos(a), MOUND_H * Math.pow(Math.sin((v * Math.PI) / 2), 0.75), 43 * r * Math.sin(a)];
  }, { wrapU: true, outward: () => [0, 1, 0] });
  const grass = landmarkMaterial(env, {
    body: /* glsl */ `
      albedo = vec3(0.13, 0.25, 0.07) * (0.8 + 0.4 * vnoise(vLocal.xz * 0.25));
      emissive = albedo * vec3(1.0, 0.7, 0.4) * 0.08 * uNight;
    `,
  });

  const group = new THREE.Group();
  group.add(new THREE.Mesh(ring.build(), steel), new THREE.Mesh(mound.build(), grass));
  return { group, beacons: [], update() {} };
}
