// Land slab (top at 1.5 m with a quay wall down to the water) and the park / beach patches just above it.
// Geometry arrives from the tile worker in global scene coordinates.
// The ground is not one colour: the city maps say how built-up each spot is, so open desert stays sand while
// city blocks turn to paving, and towers darken the streets between them and throw shadows across them.
import * as THREE from 'three';
import { COMMON, OUTPUT } from '../shaders/common.glsl.js';

export function createLand(env) {
  const group = new THREE.Group();
  const make = (cover) => new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms },
    // The cover layer sits 5 cm above the slab; the offset keeps it stable at distance.
    polygonOffset: cover,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    vertexShader: /* glsl */ `
      attribute float aKind;
      varying vec3 vWorldPos;
      varying float vKind;
      void main() {
        vKind = aKind;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec3 vWorldPos;
      varying float vKind;

      void main() {
        vec4 info = cityInfo(vWorldPos);
        float isGreen = step(0.5, vKind) * (1.0 - step(1.5, vKind));
        float isBeach = step(1.5, vKind) * (1.0 - step(2.5, vKind));
        float wall = step(2.5, vKind);

        // Desert sand with drifts, fading to paving and compacted ground where buildings stand close.
        float drift = vnoise(vWorldPos.xz * 0.0035) * 0.6 + vnoise(vWorldPos.xz * 0.03) * 0.4;
        vec3 sand = mix(vec3(0.47, 0.39, 0.25), vec3(0.56, 0.48, 0.33), drift);
        float paving = vnoise(vWorldPos.xz * 0.012 + 40.0);
        vec3 paved = mix(vec3(0.38, 0.365, 0.34), vec3(0.45, 0.43, 0.395), paving);
        float urban = smoothstep(0.02, 0.30, info.a * 0.6 + info.b * 0.6);
        vec3 albedo = mix(sand, paved, urban * 0.85);

        // Kept plain on purpose. Painted patterns (parking bays, plot lines) read as a printed texture from the
        // air; soft tone changes read as ground. The only close-up detail is scrub on open sand.
        vec2 pw = fwidth(vWorldPos.xz);
        float near = 1.0 - smoothstep(0.25, 1.4, max(pw.x, pw.y));
        albedo *= 0.94 + 0.12 * vnoise(vWorldPos.xz / 55.0 + 7.0);
        if (near > 0.001) {
          vec2 sc = vWorldPos.xz / 6.0;
          float scrub = step(0.9, hash21(floor(sc))) * (1.0 - smoothstep(0.10, 0.20, length(fract(sc) - 0.5))) * (1.0 - urban) * near;
          albedo = mix(albedo, vec3(0.17, 0.19, 0.10), scrub * 0.6);
        }

        float tuft = vnoise(vWorldPos.xz * 0.09);
        vec3 green = mix(vec3(0.10, 0.19, 0.06), vec3(0.17, 0.27, 0.09), tuft);
        albedo = mix(albedo, green, isGreen);
        albedo = mix(albedo, vec3(0.66, 0.59, 0.43) * (0.92 + 0.16 * drift), isBeach);
        albedo = mix(albedo, vec3(0.30, 0.28, 0.25), wall);

        float lit = sunLight(vWorldPos, vec3(0.0, 1.0, 0.0));
        float ao = cityAO(vWorldPos, info);
        vec3 top = shade(albedo, vec3(0.0, 1.0, 0.0), lit, ao);
        vec3 side = albedo * (hemi(vec3(1.0, 0.0, 0.0)) + uLightColor * 0.35);
        vec3 col = mix(top, side, wall);
        // Spill from the city's lights: strongest inside the built-up blocks.
        col += albedo * vec3(1.0, 0.6, 0.3) * uNight * (0.02 + 0.10 * info.a + 0.22 * info.b) * (1.0 - wall);

        col = applyFog(col, vWorldPos);
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
      }
    `,
  });

  function add(part, cover) {
    if (!part.index.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(part.position, 3));
    g.setAttribute('aKind', new THREE.BufferAttribute(part.kind, 1));
    g.setIndex(new THREE.BufferAttribute(part.index, 1));
    const mesh = new THREE.Mesh(g, make(cover));
    mesh.frustumCulled = false;
    mesh.renderOrder = cover ? -39 : -40;
    group.add(mesh);
  }

  return {
    object: group,
    /** @param {{ land: object, cover: object }} data from the worker */
    setData(data) {
      add(data.land, false);
      add(data.cover, true);
    },
  };
}
