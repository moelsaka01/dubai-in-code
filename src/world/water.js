// The sea: one 80 km plane at y = 0, drawn first without depth writes so the land slab can never z-fight it.
// Normals are analytic (four scrolling sine sets plus one noise octave); colour is a fresnel mix of the
// water body and the same analytic sky the dome uses, with a sun or moon glint.
import * as THREE from 'three';
import { COMMON, OUTPUT } from '../shaders/common.glsl.js';

export function createWater(env) {
  const material = new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms },
    depthWrite: false,
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
      varying vec3 vWorldPos;

      // Returns d(height)/dx and d(height)/dz.
      vec2 waveSlope(vec2 p, float t) {
        vec2 s = vec2(0.0);
        vec2 d; float ph;
        d = normalize(vec2(1.0, 0.35));  ph = dot(p, d) * (6.2832 / 73.0) + t * 0.9; s += d * (0.035 * cos(ph));
        d = normalize(vec2(0.6, -0.8));  ph = dot(p, d) * (6.2832 / 41.0) + t * 1.2; s += d * (0.035 * cos(ph));
        d = normalize(vec2(-0.3, 1.0));  ph = dot(p, d) * (6.2832 / 19.0) + t * 1.7; s += d * (0.040 * cos(ph));
        d = normalize(vec2(0.9, 0.9));   ph = dot(p, d) * (6.2832 / 9.5) + t * 2.3;  s += d * (0.040 * cos(ph));
        vec2 q = p * 0.13 + vec2(t * 0.21, -t * 0.17);
        float n0 = vnoise(q);
        s += (vec2(vnoise(q + vec2(0.35, 0.0)), vnoise(q + vec2(0.0, 0.35))) - n0) * 0.22;
        return s;
      }

      void main() {
        vec3 toCam = cameraPosition - vWorldPos;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        float calm = mix(1.0, 0.3, smoothstep(200.0, 5000.0, dist)); // flatten far waves, they only alias
        vec2 s = waveSlope(vWorldPos.xz, uTime) * calm;
        vec3 n = normalize(vec3(-s.x, 1.0, -s.y));

        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 R = reflect(-V, n);
        R.y = abs(R.y);
        vec3 body = uWaterDeep * (hemi(vec3(0.0, 1.0, 0.0)) + uLightColor * max(uLightDir.y, 0.0) * 0.45);
        vec3 col = mix(body, skyColor(R), fres);

        float sp = max(dot(R, uLightDir), 0.0);
        col += uLightColor * (pow(sp, 600.0) * 6.0 + pow(sp, 60.0) * 0.25);

        col = applyFog(col, vWorldPos);
        col *= 1.0 + (hash21(gl_FragCoord.xy) - 0.5) * 0.03;
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
      }
    `,
  });
  const geometry = new THREE.PlaneGeometry(80000, 80000);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -50;
  return { object: mesh };
}
