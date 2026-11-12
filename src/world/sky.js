// Sky dome: gradient, sun disc and halo, moon, stars. Follows the camera, sits on the far plane and is drawn
// last, so only the pixels nothing else covered are shaded.
import * as THREE from 'three';
import { COMMON, OUTPUT } from '../shaders/common.glsl.js';

export function createSky(env) {
  const material = new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms },
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // depth 1.0
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec3 vDir;

      void main() {
        vec3 d = normalize(vDir);
        vec3 col = skyColor(d);
        float above = smoothstep(-0.015, 0.02, d.y);

        // High thin cloud: streaks of noise on a flat layer far overhead, lit by the sky and the low sun.
        if (d.y > 0.02) {
          vec2 cp = d.xz / (d.y + 0.12) * 1.6 + vec2(uTime * 0.004, 0.0);
          float c = vnoise(cp * vec2(1.0, 2.6)) * 0.62 + vnoise(cp * vec2(2.9, 6.5) + 9.0) * 0.38;
          float cover = smoothstep(0.52, 0.80, c) * smoothstep(0.02, 0.25, d.y) * mix(0.55, 0.3, uNight);
          vec3 cloud = uAmbSky * 2.2 + uLightColor * 0.9 + uSkyHorizon * 0.25 + uSkyGlow * (0.5 * pow(max(dot(d, uSunDir), 0.0), 3.0));
          col = mix(col, cloud, cover);
        }

        float mu = dot(d, uSunDir);
        col += uSunDisc * above * (smoothstep(0.99990, 0.99996, mu) + 0.02 * pow(max(mu, 0.0), 1200.0));

        if (uStars > 0.001) {
          vec3 p = d * 190.0;
          vec3 cell = floor(p);
          float h = hash31(cell);
          float r = length(fract(p) - 0.5);
          float twinkle = 0.7 + 0.3 * sin(uTime * (1.0 + 3.0 * h) + h * 40.0);
          float star = step(0.9955, h) * (1.0 - smoothstep(0.0, 0.22, r)) * twinkle;
          col += vec3(0.9, 0.95, 1.0) * star * uStars * smoothstep(0.04, 0.3, d.y) * 1.2;

          float mm = dot(d, uMoonDir);
          col += vec3(0.85, 0.9, 1.0) * uStars * (1.4 * smoothstep(0.99992, 0.99996, mm) + 0.05 * pow(max(mm, 0.0), 600.0));
        }

        col *= 1.0 + (hash21(gl_FragCoord.xy) - 0.5) * 0.03; // dither against banding
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), material);
  mesh.scale.setScalar(30000);
  mesh.frustumCulled = false;
  mesh.renderOrder = 100;
  return { object: mesh, update(camera) { mesh.position.copy(camera.position); } };
}
