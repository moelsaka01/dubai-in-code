// Land slab (sand top at 1.5 m with a quay wall down to the water) and the park / beach patches just above it.
// Geometry arrives from the tile worker in global scene coordinates.
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
        vec3 sand = vec3(0.50, 0.42, 0.27);
        vec3 green = vec3(0.13, 0.24, 0.07);
        vec3 beach = vec3(0.64, 0.56, 0.39);
        vec3 quay = vec3(0.30, 0.28, 0.24);
        vec3 albedo = sand;
        albedo = mix(albedo, green, step(0.5, vKind));
        albedo = mix(albedo, beach, step(1.5, vKind));
        float wall = step(2.5, vKind);
        albedo = mix(albedo, quay, wall);

        float mottle = vnoise(vWorldPos.xz * 0.004) * 0.6 + vnoise(vWorldPos.xz * 0.035) * 0.4;
        albedo *= 0.86 + 0.28 * mottle;

        vec3 top = shadeLambert(albedo, vec3(0.0, 1.0, 0.0));
        vec3 side = albedo * (hemi(vec3(1.0, 0.0, 0.0)) + uLightColor * 0.35);
        vec3 col = mix(top, side, wall);
        col += albedo * vec3(1.0, 0.6, 0.3) * 0.02 * uNight; // spill from the city's lights

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
