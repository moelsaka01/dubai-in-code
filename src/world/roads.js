// Road ribbons (one mesh per tile, one shared material) and the street lights along class 0-2 roads.
// Index buffers hold major classes first, so far tiles drop residential and tertiary roads by draw range.
import * as THREE from 'three';
import { COMMON, OUTPUT } from '../shaders/common.glsl.js';
import { createLightPoints } from './lightPoints.js';

export function createRoads(env) {
  const group = new THREE.Group();
  const material = new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms },
    side: THREE.DoubleSide,
    // Roads lie 10 cm above the land slab; the offset keeps them on top at distance.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
    vertexShader: /* glsl */ `
      attribute vec2 aUv;   // x: -1 left edge .. +1 right edge, y: metres along the way
      attribute vec4 aInfo; // class, lanes, flags, half width * 8
      varying vec3 vWorldPos;
      varying vec2 vUv;
      varying vec4 vInfo;
      void main() {
        vUv = aUv;
        vInfo = aInfo;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec3 vWorldPos;
      varying vec2 vUv;
      varying vec4 vInfo;

      void main() {
        float cls = floor(vInfo.x + 0.5);
        float lanes = max(floor(vInfo.y + 0.5), 1.0);
        float hw = vInfo.w / 8.0;
        float x = vUv.x * hw; // metres from the centre line
        float rail = step(6.5, cls);
        float major = 1.0 - step(2.5, cls); // motorway, trunk, primary
        float marked = 1.0 - step(3.5, cls);

        vec3 albedo = mix(vec3(0.050, 0.051, 0.055), vec3(0.085, 0.082, 0.076), step(3.5, cls));
        albedo = mix(albedo, vec3(0.34, 0.33, 0.31), rail);
        albedo *= 0.9 + 0.2 * vnoise(vWorldPos.xz * 0.05);

        // Lane markings, only where a pixel is small enough to resolve them.
        float fwx = max(fwidth(x), 1e-4);
        float detail = (1.0 - smoothstep(0.12, 0.5, fwx)) * marked * (1.0 - rail);
        float inner = hw - 0.7;
        float lw = 2.0 * inner / lanes;
        float lx = (x + inner) / lw;
        float dLane = abs(fract(lx + 0.5) - 0.5) * lw;
        float between = step(0.5, lx) * step(lx, lanes - 0.5);
        float dash = step(0.5, fract(vUv.y / 12.0));
        float mark = (1.0 - smoothstep(0.07, 0.07 + fwx, dLane)) * between * dash;
        mark = max(mark, 1.0 - smoothstep(0.08, 0.08 + fwx, abs(abs(x) - inner)));
        albedo = mix(albedo, vec3(0.62), mark * detail * 0.85);

        vec3 col = shadeLambert(albedo, vec3(0.0, 1.0, 0.0));

        // Night: pools of sodium light down the middle of the big roads, a faint wash on the rest.
        float across = exp(-vUv.x * vUv.x * 1.6);
        float pool = 0.62 + 0.38 * cos((vUv.y - 20.0) * (6.2832 / 40.0));
        vec3 sodium = vec3(1.0, 0.56, 0.2);
        col += sodium * uNight * (1.0 - rail) * mix(0.02, 0.14 * across * pool, major);

        col = applyFog(col, vWorldPos);
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
      }
    `,
  });

  const lights = createLightPoints(env, { capacity: 60000, color: [2.4, 1.45, 0.6], size: 6 });
  group.add(lights.object);

  const tiles = [];
  const centre = new THREE.Vector3();

  return {
    object: group,
    lights,
    addTile(origin, d) {
      lights.add(d.lights);
      if (!d.index.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
      g.setAttribute('aUv', new THREE.BufferAttribute(d.uv, 2));
      g.setAttribute('aInfo', new THREE.BufferAttribute(d.info, 4));
      g.setIndex(new THREE.BufferAttribute(d.index, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(...d.center), d.radius);
      const mesh = new THREE.Mesh(g, material);
      mesh.position.set(origin[0], origin[1], origin[2]);
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = -30;
      group.add(mesh);
      tiles.push({ mesh, all: d.index.length, major: d.majorIndexCount, centre: new THREE.Vector3(...d.center).add(mesh.position), radius: d.radius });
    },
    /** @param {number} minorFar distance (m) beyond which class >= 4 roads are hidden */
    update(camera, minorFar) {
      lights.update();
      for (const t of tiles) {
        const far = centre.copy(t.centre).sub(camera.position).length() - t.radius > minorFar;
        const count = far ? t.major : t.all;
        t.mesh.visible = count > 0;
        t.mesh.geometry.setDrawRange(0, count);
      }
    },
  };
}
