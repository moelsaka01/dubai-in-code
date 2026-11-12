// A fixed-capacity cloud of additive light points (street lights, aviation beacons). One draw call.
// Points shrink with distance down to a minimum pixel size, after which they dim instead, so far lights
// merge into a glow rather than popping or shimmering.
import * as THREE from 'three';
import { COMMON, OUTPUT } from '../shaders/common.glsl.js';

export function createLightPoints(env, { capacity, color, size, blink = 0 }) {
  const array = new Float32Array(capacity * 3);
  const attribute = new THREE.BufferAttribute(array, 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', attribute);
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms, uColor: { value: new THREE.Color().setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace) }, uSize: { value: size }, uBlink: { value: blink } },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      uniform float uPixelScale;
      uniform float uSize;
      uniform float uBlink;
      uniform float uTime;
      varying float vAlpha;
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vec4 mv = viewMatrix * wp;
        float d = max(-mv.z, 1.0);
        float px = uSize * uPixelScale / d;
        float s = clamp(px, 1.5, 28.0);
        float a = max(min(1.0, (px * px) / (s * s)), 0.06);
        float phase = fract(sin(dot(position.xz, vec2(12.9898, 78.233))) * 43758.5453);
        float pulse = 0.2 + 0.8 * smoothstep(0.0, 0.3, sin(uTime * 2.4 + phase * 6.2832));
        vAlpha = a * mix(1.0, pulse, uBlink);
        gl_PointSize = s;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform vec3 uColor;
      varying float vAlpha;
      varying vec3 vWorldPos;
      void main() {
        float g = max(1.0 - length(gl_PointCoord - 0.5) * 2.0, 0.0);
        vec3 col = uColor * (g * g * vAlpha * uNight * fogTransmittance(vWorldPos));
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.visible = false;
  let count = 0;

  return {
    object: points,
    get count() { return count; },
    /** Append xyz triples (scene coordinates). Extra points beyond the capacity are dropped. */
    add(xyz) {
      const n = Math.min(Math.floor(xyz.length / 3), capacity - count);
      if (n <= 0) return;
      array.set(n * 3 === xyz.length ? xyz : xyz.subarray ? xyz.subarray(0, n * 3) : xyz.slice(0, n * 3), count * 3);
      count += n;
      attribute.needsUpdate = true;
      geometry.setDrawRange(0, count);
    },
    update() {
      points.visible = count > 0 && env.night > 0.02;
    },
  };
}
