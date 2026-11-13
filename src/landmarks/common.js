// Shared pieces for the procedural landmarks: a small geometry builder and a material factory
// that uses the scene's common lighting, sky reflection and fog.
//
// "Plan coordinates" are (px, pn): metres along the landmark's own east and north before it is rotated
// into place. In the scene that is (x, z) = (px, -pn). Outlines are listed counter-clockwise in plan.
import * as THREE from 'three';
import { COMMON, OUTPUT } from '../shaders/common.glsl.js';

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export class GeoBuilder {
  constructor() {
    this.p = [];
    this.n = [];
    this.uv = [];
    this.i = [];
  }

  get count() {
    return this.p.length / 3;
  }

  vert(x, y, z, nx, ny, nz, u, v) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.uv.push(u, v);
    return this.p.length / 3 - 1;
  }

  /**
   * Vertical prism from a plan outline [[px, pn], ...] between y0 and y1, with an optional top cap.
   * uv = (metres along the perimeter, y). Normals are smoothed across edges that meet at less than ~35 degrees.
   */
  prism(outline, y0, y1, { cap = true, smoothCos = 0.82 } = {}) {
    const pts = signedArea(outline) < 0 ? outline.slice().reverse() : outline;
    const n = pts.length;
    const en = [];
    for (let j = 0; j < n; j++) {
      const a = pts[j], b = pts[(j + 1) % n];
      const de = b[0] - a[0], dn = b[1] - a[1];
      const len = Math.hypot(de, dn) || 1;
      en.push([dn / len, -de / len, len]); // outward normal in plan, edge length
    }
    const blend = (e, o) => {
      if (e[0] * o[0] + e[1] * o[1] <= smoothCos) return e;
      const x = e[0] + o[0], y = e[1] + o[1], l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    };
    let u = 0;
    for (let j = 0; j < n; j++) {
      const a = pts[j], b = pts[(j + 1) % n], e = en[j];
      const na = blend(e, en[(j - 1 + n) % n]), nb = blend(e, en[(j + 1) % n]);
      const v0 = this.vert(a[0], y0, -a[1], na[0], 0, -na[1], u, y0);
      this.vert(b[0], y0, -b[1], nb[0], 0, -nb[1], u + e[2], y0);
      this.vert(b[0], y1, -b[1], nb[0], 0, -nb[1], u + e[2], y1);
      this.vert(a[0], y1, -a[1], na[0], 0, -na[1], u, y1);
      this.i.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
      u += e[2];
    }
    if (cap) {
      const base = this.count;
      for (const p of pts) this.vert(p[0], y1, -p[1], 0, 1, 0, 0, y1);
      const faces = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p[0], -p[1])), []);
      for (const [a, b, c] of faces) {
        const A = pts[a], B = pts[b], C = pts[c];
        // Face +y: in (x, z) = (px, -pn) that needs a positive (B-A) x (C-A) in plan.
        const up = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) > 0;
        if (up) this.i.push(base + a, base + b, base + c);
        else this.i.push(base + a, base + c, base + b);
      }
    }
    return this;
  }

  /**
   * Skin between stacked rings. rings[i][j] = [px, y, pn]; every ring has the same number of points, listed
   * counter-clockwise in plan. `skip` holds column indices j whose quad (j -> j+1) is left out: repeat a point
   * and skip the column between the copies to get a hard edge. uv = (us[j] or perimeter of the first ring, y).
   */
  loft(rings, { closed = false, skip = null, us = null } = {}) {
    const R = rings.length, M = rings[0].length, cols = closed ? M + 1 : M;
    const base = this.count;
    if (!us) {
      us = [0];
      for (let j = 1; j < cols; j++) {
        const a = rings[0][(j - 1) % M], b = rings[0][j % M];
        us.push(us[j - 1] + Math.hypot(b[0] - a[0], b[2] - a[2]));
      }
    }
    for (let i = 0; i < R; i++) {
      for (let j = 0; j < cols; j++) {
        const p = rings[i][j % M];
        this.vert(p[0], p[1], -p[2], 0, 0, 0, us[j], p[1]);
      }
    }
    const first = this.i.length;
    const P = this.p, N = this.n;
    const faceNormal = (a, b, c) => {
      const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
      const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
      return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    };
    const tri = (a, b, c) => {
      const f = faceNormal(a, b, c);
      for (const k of [a, b, c]) { N[3 * k] += f[0]; N[3 * k + 1] += f[1]; N[3 * k + 2] += f[2]; }
      this.i.push(a, b, c);
    };
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        if (skip && skip.has(j)) continue;
        const a = base + i * cols + j, b = a + 1, c = b + cols, d = a + cols;
        tri(a, b, c);
        tri(a, c, d);
      }
    }
    if (closed) {
      for (let i = 0; i < R; i++) {
        const a = base + i * cols, b = a + M;
        for (let k = 0; k < 3; k++) { const s = N[3 * a + k] + N[3 * b + k]; N[3 * a + k] = s; N[3 * b + k] = s; }
      }
    }
    // Insurance: the summed normals must point away from the axis through the ring centres.
    let out = 0;
    for (let i = 0; i < R; i++) {
      let cx = 0, cz = 0;
      for (let j = 0; j < M; j++) { cx += rings[i][j][0]; cz -= rings[i][j][2]; }
      cx /= M; cz /= M;
      for (let j = 0; j < cols; j++) {
        const k = base + i * cols + j;
        out += N[3 * k] * (P[3 * k] - cx) + N[3 * k + 2] * (P[3 * k + 2] - cz);
      }
    }
    const flip = out < 0;
    if (flip) for (let t = first; t < this.i.length; t += 3) { const s = this.i[t + 1]; this.i[t + 1] = this.i[t + 2]; this.i[t + 2] = s; }
    for (let k = base; k < this.count; k++) {
      const l = (Math.hypot(N[3 * k], N[3 * k + 1], N[3 * k + 2]) || 1) * (flip ? -1 : 1);
      N[3 * k] /= l; N[3 * k + 1] /= l; N[3 * k + 2] /= l;
    }
    return this;
  }

  /**
   * Parametric surface fn(u, v) -> [x, y, z] in local scene coordinates, u and v in [0, 1].
   * Normals come from the faces; `outward(p)` gives a rough outward direction used to pick the winding.
   * wrapU / wrapV weld the normals across the seam. uv = (u, v).
   */
  grid(nu, nv, fn, { wrapU = false, wrapV = false, outward }) {
    const base = this.count, cols = nu + 1;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const p = fn(i / nu, j / nv);
        this.vert(p[0], p[1], p[2], 0, 0, 0, i / nu, j / nv);
      }
    }
    const P = this.p, N = this.n;
    const first = this.i.length;
    let agree = 0;
    const tri = (a, b, c) => {
      const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
      const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
      const f = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      for (const k of [a, b, c]) { N[3 * k] += f[0]; N[3 * k + 1] += f[1]; N[3 * k + 2] += f[2]; }
      const o = outward([P[3 * a], P[3 * a + 1], P[3 * a + 2]]);
      agree += f[0] * o[0] + f[1] * o[1] + f[2] * o[2];
      this.i.push(a, b, c);
    };
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * cols + i, b = a + 1, c = b + cols, d = a + cols;
        tri(a, b, c);
        tri(a, c, d);
      }
    }
    const weld = (a, b) => { for (let k = 0; k < 3; k++) { const s = N[3 * a + k] + N[3 * b + k]; N[3 * a + k] = s; N[3 * b + k] = s; } };
    if (wrapU) for (let j = 0; j <= nv; j++) weld(base + j * cols, base + j * cols + nu);
    if (wrapV) for (let i = 0; i <= nu; i++) weld(base + i, base + nv * cols + i);
    const flip = agree < 0;
    if (flip) for (let t = first; t < this.i.length; t += 3) { const s = this.i[t + 1]; this.i[t + 1] = this.i[t + 2]; this.i[t + 2] = s; }
    for (let k = base; k < this.count; k++) {
      const l = (Math.hypot(N[3 * k], N[3 * k + 1], N[3 * k + 2]) || 1) * (flip ? -1 : 1);
      N[3 * k] /= l; N[3 * k + 1] /= l; N[3 * k + 2] /= l;
    }
    return this;
  }

  /** Append a three.js geometry (position + normal), optionally transformed. Its uv becomes (u, local y). */
  add(geometry, matrix = null, u = 0) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    const pos = g.getAttribute('position'), nor = g.getAttribute('normal');
    const base = this.count;
    for (let k = 0; k < pos.count; k++) {
      this.vert(pos.getX(k), pos.getY(k), pos.getZ(k), nor.getX(k), nor.getY(k), nor.getZ(k), u, pos.getY(k));
      this.i.push(base + k);
    }
    g.dispose();
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** A cylinder (or cone frustum) between two local points, as a three.js geometry ready for GeoBuilder.add(). */
export function strut(from, to, r0, r1, sides = 8) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

/**
 * Landmark surface material. `body` is GLSL that may set: albedo, emissive, gloss (0..1 mirror reflection),
 * metal (0..1: reflects at every angle, not only at grazing ones), skyward (0..1: the mirror shows the sky this
 * wall faces instead of the ground below the viewer; for tall glass seen from the air, as on the city's towers).
 * It can read n (world normal), V (to camera), vLocal (object-space position), vUv, vWorldPos.
 */
export function landmarkMaterial(env, { body, decl = '', uniforms = {}, side = THREE.FrontSide }) {
  return new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms, ...uniforms },
    side,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying vec3 vLocal;
      varying vec3 vOrigin; // world position of this object's (or instance's) origin
      varying vec2 vUv;
      void main() {
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = modelMatrix * instanceMatrix;
        #endif
        vec4 wp = m * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormal = mat3(m) * normal;
        vLocal = position;
        vOrigin = m[3].xyz;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying vec3 vLocal;
      varying vec3 vOrigin;
      varying vec2 vUv;
      ${decl}

      void main() {
        vec3 n = normalize(vNormal);
        #ifdef DOUBLE_SIDED
          if (!gl_FrontFacing) n = -n;
        #endif
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 albedo = vec3(0.7);
        vec3 emissive = vec3(0.0);
        float gloss = 0.0;
        float metal = 0.0;
        float skyward = 0.0;
        ${body}
        // Sun shadow and occlusion from the city maps, sampled a little outside the surface.
        vec3 outside = vWorldPos + n * 9.0;
        float lit = sunLight(vWorldPos, n);
        float ao = cityAO(vWorldPos, cityInfo(outside));
        vec3 col = shade(albedo, n, lit, ao);
        vec3 R = reflect(-V, n);
        float fres = pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 mirror = envColor(normalize(mix(R, vec3(R.x, abs(R.y) * 0.5 + 0.08, R.z), skyward))) * mix(0.7, 1.0, ao);
        col = mix(col, mirror, gloss * mix(0.25 + 0.75 * fres, 0.75 + 0.25 * fres, metal));
        col += uLightColor * (pow(max(dot(R, uLightDir), 0.0), 80.0) * gloss * 0.8 * lit);
        col = applyFog(col + emissive, vWorldPos);
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
      }
    `,
  });
}

/** Unlit-ish line material (cables, spokes) that still takes ambient light and fog. */
export function lineMaterial(env, rgb) {
  return new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms, uColor: { value: new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace) } },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform vec3 uColor;
      varying vec3 vWorldPos;
      void main() {
        vec3 col = uColor * (hemi(vec3(0.0, 1.0, 0.0)) + uLightColor * 0.6 + vec3(0.03, 0.035, 0.045) * uNight);
        gl_FragColor = vec4(applyFog(col, vWorldPos), 1.0);
        ${OUTPUT}
      }
    `,
  });
}
