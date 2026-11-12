// Car lights: one instanced draw call of camera-facing quads that travel along the motorway polylines in
// traffic.json. A car shows white when it drives toward the camera and red when it drives away.
import * as THREE from 'three';
import { COMMON, OUTPUT } from '../shaders/common.glsl.js';

const CAR_Y = 2.6;

export function createTraffic(env, traffic, count = 1500) {
  // Arc-length tables.
  const lines = [];
  const addLine = (pts, halfSpread, weight) => {
    const n = pts.length / 2;
    if (n < 2) return;
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
    if (cum[n - 1] > 100) lines.push({ pts, cum, length: cum[n - 1], halfSpread, weight: cum[n - 1] * weight });
  };
  for (const p of traffic.szr) addLine(p, 9, 1.7); // Sheikh Zayed Road: wide and busy
  for (const p of traffic.motorways) addLine(p, 4.5, 1);

  const total = lines.reduce((s, l) => s + l.weight, 0) || 1;
  const cars = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (const [li, l] of lines.entries()) {
    const n = Math.round((count * l.weight) / total);
    for (let i = 0; i < n && cars.length < count; i++) {
      const lane = Math.round((rnd() * 2 - 1) * (l.halfSpread / 3.6)) * 3.6;
      cars.push({ line: li, s: rnd() * l.length, seg: 0, speed: 22 + rnd() * 12, lateral: lane });
    }
  }
  const n = cars.length;

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(n, 1) * 3), 3);
  const iDir = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(n, 1) * 2), 2);
  iPos.setUsage(THREE.DynamicDrawUsage);
  iDir.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('iPos', iPos);
  geometry.setAttribute('iDir', iDir);
  geometry.instanceCount = n;

  const material = new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute vec2 iDir;
      uniform float uPixelScale;
      varying vec2 vQuad;
      varying vec3 vColor;
      varying vec3 vWorldPos;
      void main() {
        vQuad = position.xy;
        vWorldPos = iPos;
        vec4 mv = viewMatrix * vec4(iPos, 1.0);
        float d = max(-mv.z, 1.0);
        vec3 toCam = normalize(cameraPosition - iPos);
        float facing = smoothstep(-0.12, 0.12, dot(vec3(iDir.x, 0.0, iDir.y), toCam));
        float sizeM = mix(2.2, 3.4, facing); // headlights read larger than tail lights
        float px = sizeM * uPixelScale / d;
        float s = max(px, 1.6);
        float fade = max(min(1.0, (px * px) / (s * s)), 0.08);
        vColor = mix(vec3(2.2, 0.10, 0.05), vec3(2.6, 2.4, 2.0), facing) * fade;
        mv.xy += position.xy * (0.5 * s * d / uPixelScale);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec2 vQuad;
      varying vec3 vColor;
      varying vec3 vWorldPos;
      void main() {
        float g = max(1.0 - length(vQuad), 0.0);
        vec3 col = vColor * (g * g * (0.1 + 0.9 * uNight) * fogTransmittance(vWorldPos));
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  function place() {
    const P = iPos.array, D = iDir.array;
    for (let i = 0; i < n; i++) {
      const c = cars[i], l = lines[c.line];
      const cum = l.cum, pts = l.pts;
      let k = c.seg;
      if (c.s < cum[k]) k = 0;
      while (k < cum.length - 2 && c.s > cum[k + 1]) k++;
      c.seg = k;
      const f = (c.s - cum[k]) / (cum[k + 1] - cum[k] || 1);
      const ax = pts[2 * k], an = pts[2 * k + 1], bx = pts[2 * k + 2], bn = pts[2 * k + 3];
      let de = bx - ax, dn = bn - an;
      const len = Math.hypot(de, dn) || 1;
      de /= len; dn /= len;
      const e = ax + (bx - ax) * f + dn * c.lateral; // lateral offset to the right of travel
      const north = an + (bn - an) * f - de * c.lateral;
      P[3 * i] = e; P[3 * i + 1] = CAR_Y; P[3 * i + 2] = -north;
      D[2 * i] = de; D[2 * i + 1] = -dn;
    }
    iPos.needsUpdate = true;
    iDir.needsUpdate = true;
  }
  place();

  return {
    object: mesh,
    count: n,
    update(dt) {
      for (let i = 0; i < n; i++) {
        const c = cars[i];
        c.s += c.speed * dt;
        const len = lines[c.line].length;
        if (c.s >= len) { c.s -= len; c.seg = 0; }
      }
      place();
    },
  };
}
