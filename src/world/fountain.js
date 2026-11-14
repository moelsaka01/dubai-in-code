// The Dubai Fountain: a line of jets on the Burj lake, in front of the mall. One draw call of points; every jet
// is a column of droplets whose height is worked out in the vertex shader from the clock, so the whole show
// costs nothing on the CPU. The jets rise and fall in waves that travel along the arc, as the real ones do.
// Lit warm white after dark; by day it is pale spray.
import * as THREE from 'three';
import { COMMON, OUTPUT } from '../shaders/common.glsl.js';

// The arc, in (east, north) metres: measured from the water mask of the lake, kept clear of its banks.
const WEST = 7815, EAST = 8040, NORTH = 5600, BOW = 12;
const JETS = 46, DROPS = 26; // enough droplets that a jet is a column, not a string of beads
const TOP = 78; // metres; the tallest real jets reach about 150
const FAR = 5000; // not drawn beyond this distance from the camera

export function createFountain(env) {
  const n = JETS * DROPS;
  const base = new Float32Array(n * 3), info = new Float32Array(n * 3);
  for (let j = 0; j < JETS; j++) {
    const f = j / (JETS - 1);
    const east = WEST + (EAST - WEST) * f, north = NORTH + BOW * Math.sin(Math.PI * f);
    for (let k = 0; k < DROPS; k++) {
      const i = j * DROPS + k;
      base[i * 3] = east; base[i * 3 + 1] = 0.6; base[i * 3 + 2] = -north;
      info[i * 3] = f; info[i * 3 + 1] = (k + 0.5) / DROPS; info[i * 3 + 2] = ((j * 37 + k * 11) % 17) / 17;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(base, 3));
  geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 3)); // place along the arc, place up the jet, seed
  const centre = new THREE.Vector3((WEST + EAST) / 2, 0, -NORTH);
  geometry.boundingSphere = new THREE.Sphere(centre.clone(), (EAST - WEST) / 2 + TOP);

  const material = new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec3 aInfo;
      uniform float uTime;
      uniform float uPixelScale;
      varying float vGlow;
      varying vec3 vWorldPos;
      void main() {
        float along = aInfo.x, up = aInfo.y, seed = aInfo.z;
        // Two waves travel along the arc in opposite directions and a slow swell lifts the whole line.
        float w1 = 0.5 + 0.5 * sin(uTime * 1.1 - along * 9.0);
        float w2 = 0.5 + 0.5 * sin(uTime * 0.7 + along * 5.0 + 1.7);
        float swell = 0.55 + 0.45 * sin(uTime * 0.19);
        float h = ${TOP.toFixed(1)} * (0.12 + 0.88 * w1 * w1 * mix(0.5, 1.0, w2)) * swell;
        vec3 p = position;
        p.y += h * up;
        // Water thrown up slows and spreads: the column widens and leans a little toward the top.
        float spread = up * up * (1.5 + h * 0.035);
        p.x += sin(seed * 40.0 + uTime * 2.3) * spread;
        p.z += cos(seed * 23.0 + uTime * 1.9) * spread;
        vWorldPos = p;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float d = max(-mv.z, 1.0);
        float px = mix(5.0, 2.6, up) * uPixelScale / d;
        gl_PointSize = clamp(px, 1.5, 40.0);
        vGlow = mix(1.0, 0.45, up) * min(1.0, px / 1.5) * smoothstep(0.0, 4.0, h);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying float vGlow;
      varying vec3 vWorldPos;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float soft = max(1.0 - r, 0.0);
        // After dark the jets are lit from below, warm white. By day they are spray in sunlight.
        vec3 lit = mix((uLightColor + uAmbSky * 2.0) * 0.14, vec3(1.0, 0.86, 0.62) * 0.5, uNight);
        gl_FragColor = vec4(lit * (soft * soft * vGlow * fogTransmittance(vWorldPos)), 1.0);
        ${OUTPUT}
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  return {
    object: points,
    update(camera) {
      points.visible = camera.position.distanceTo(centre) < FAR;
    },
  };
}
