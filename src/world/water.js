// The sea: one 80 km plane at y = 0, drawn after the land and buildings so hidden pixels cost nothing.
// Normals come from three octaves of drifting noise, each one faded out once its waves get smaller than a few
// pixels (regular sine waves showed moire rings). Colour is a fresnel mix of the water body and the same sky
// the dome uses, with a sun or moon glint. Near land the city map's shore channel turns the water turquoise
// and draws a line of surf.
import * as THREE from 'three';
import { COMMON, OUTPUT } from '../shaders/common.glsl.js';

export function createWater(env) {
  const material = new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms },
    // Pushed back a little so the land slab, 1.5 m above, always wins the depth test.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 4,
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

      // Value noise with its gradient: x = value, yz = d/dx, d/dy.
      vec3 noised(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
        float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
        float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
        return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
      }

      void main() {
        vec3 toCam = cameraPosition - vWorldPos;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        vec4 info = cityInfo(vWorldPos);

        // Slope of the surface. Octaves that the screen cannot resolve are dropped and widen the highlight instead.
        vec2 p = vWorldPos.xz;
        vec2 px = fwidth(p);
        float footprint = max(px.x, px.y);
        vec2 slope = vec2(0.0);
        float lost = 0.0;
        mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
        mat2 acc = mat2(1.0, 0.0, 0.0, 1.0);
        float wavelength = 41.0, height = 0.55;
        for (int i = 0; i < 3; i++) {
          float keep = 1.0 - smoothstep(0.12, 0.4, footprint / wavelength);
          vec2 q = acc * p / wavelength + vec2(0.31, -0.23) * uTime * (1.0 + float(i));
          vec3 nz = noised(q);
          vec2 s = ((nz.yz - 0.0) * acc) * (height / wavelength) * 2.2;
          slope += s * keep;
          lost += (1.0 - keep) * (height / wavelength);
          acc = turn * acc;
          wavelength *= 0.43;
          height *= 0.5;
        }
        vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 R = reflect(-V, n);
        R.y = abs(R.y);
        float lit = sunLit(vWorldPos + vec3(0.0, 1.0, 0.0));
        vec3 light = hemi(vec3(0.0, 1.0, 0.0)) + uLightColor * (max(uLightDir.y, 0.0) * 0.45 * lit);

        // Shallows: turquoise over sand near any shore, with a broken line of surf where the land starts.
        float shallow = smoothstep(0.02, 0.42, info.g);
        vec3 body = mix(uWaterDeep, uWaterDeep * 0.5 + vec3(0.05, 0.36, 0.34), shallow * 0.85) * light;
        float surf = smoothstep(0.37, 0.45, info.g) * (1.0 - smoothstep(0.45, 0.52, info.g));
        surf *= smoothstep(0.35, 0.75, vnoise(p * 0.12 + uTime * 0.15));
        body = mix(body, vec3(0.75) * light, surf * 0.55);

        vec3 col = mix(body, skyColor(R), fres * (1.0 - surf * 0.5));

        float sp = max(dot(R, uLightDir), 0.0);
        float sharp = mix(600.0, 40.0, clamp(lost * 60.0, 0.0, 1.0));
        col += uLightColor * lit * (pow(sp, sharp) * mix(6.0, 0.5, clamp(lost * 60.0, 0.0, 1.0)) + pow(sp, 60.0) * 0.2);
        // The city's lights smear across the water close to shore.
        col += vec3(1.0, 0.62, 0.3) * uNight * (0.05 * shallow + 0.10 * info.a);

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
  mesh.renderOrder = 50;
  return { object: mesh };
}
