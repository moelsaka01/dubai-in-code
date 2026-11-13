// Roads, drawn the way a map is: every road twice. First a wider "casing" in pavement colour, then the
// carriageway on top. Because all casings are drawn before all carriageways, junctions merge into one surface
// with a continuous kerb instead of ribbons lying across each other.
// One geometry per tile, shared by both passes; the casing pass pushes each vertex sideways in the vertex shader.
// Index buffers hold major classes first, so far tiles drop residential and tertiary roads by draw range.
// Bridges come from the worker already raised, with skirts along their edges.
import * as THREE from 'three';
import { COMMON, OUTPUT } from '../shaders/common.glsl.js';
import { createLightPoints } from './lightPoints.js';

const PAVEMENT = 2.4; // metres of kerb and footway on each side

export function createRoads(env) {
  const group = new THREE.Group();
  const make = (casing) => new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms, uGrow: { value: casing ? PAVEMENT : 0 }, uCasing: { value: casing ? 1 : 0 } },
    side: THREE.DoubleSide,
    // Roads lie just above the land slab; the offset keeps them on top at distance, carriageway over casing.
    polygonOffset: true,
    polygonOffsetFactor: casing ? -2 : -3,
    polygonOffsetUnits: casing ? -8 : -12,
    vertexShader: /* glsl */ `
      attribute vec2 aUv;   // x: -1 left edge .. +1 right edge (2 on a bridge skirt), y: metres along the way
      attribute vec2 aSide; // sideways movement per metre of extra half-width
      attribute vec4 aInfo; // class, lanes, flags, half width * 8
      uniform float uGrow;
      varying vec3 vWorldPos;
      varying vec2 vUv;
      varying vec4 vInfo;
      void main() {
        vUv = aUv;
        vInfo = aInfo;
        float rail = step(6.5, aInfo.x);
        vec3 p = position;
        p.xz += aSide * uGrow * (1.0 - rail);
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform float uCasing;
      varying vec3 vWorldPos;
      varying vec2 vUv;
      varying vec4 vInfo;

      void main() {
        float cls = floor(vInfo.x + 0.5);
        float lanes = max(floor(vInfo.y + 0.5), 1.0);
        float oneway = step(3.5, mod(floor(vInfo.z + 0.5), 8.0));
        float hw = vInfo.w / 8.0;
        float x = vUv.x * hw; // metres from the centre line
        float rail = step(6.5, cls);
        float major = 1.0 - step(2.5, cls); // motorway, trunk, primary
        float skirt = step(1.5, abs(vUv.x));
        if (uCasing > 0.5 && rail > 0.5) discard;

        // Sun-bleached asphalt is mid grey, not black; side streets are paler and dustier.
        vec3 albedo = mix(vec3(0.115, 0.115, 0.120), vec3(0.165, 0.158, 0.146), step(3.5, cls));
        albedo = mix(albedo, vec3(0.34, 0.33, 0.31), rail);
        albedo *= 0.92 + 0.16 * vnoise(vWorldPos.xz * 0.04);

        // Markings stay quiet: lane dashes on motorways and trunk roads, one centre line on two-way main
        // roads, and only where a pixel is small enough to resolve them.
        float fwx = max(fwidth(x), 1e-4);
        float detail = (1.0 - smoothstep(0.12, 0.5, fwx)) * (1.0 - rail) * (1.0 - skirt);
        float lw = 2.0 * (hw - 0.7) / lanes;
        float lx = (x + hw - 0.7) / lw;
        float dLane = abs(fract(lx + 0.5) - 0.5) * lw;
        float dashes = (1.0 - smoothstep(0.06, 0.06 + fwx, dLane)) * step(0.5, lx) * step(lx, lanes - 0.5)
          * step(0.5, fract(vUv.y / 12.0)) * (1.0 - step(1.5, cls));
        float centre = (1.0 - smoothstep(0.07, 0.07 + fwx, abs(x))) * step(1.5, cls) * (1.0 - step(3.5, cls)) * (1.0 - oneway);
        albedo = mix(albedo, vec3(0.55), max(dashes, centre) * detail * 0.7);

        // The casing is pavement: pale concrete with a darker kerb joint where it meets the carriageway.
        vec3 pavement = vec3(0.40, 0.385, 0.36) * (0.94 + 0.12 * vnoise(vWorldPos.xz * 0.3));
        albedo = mix(albedo, pavement, uCasing);
        albedo = mix(albedo, vec3(0.30, 0.29, 0.28), skirt); // the side of a bridge deck

        vec4 info = cityInfo(vWorldPos);
        vec3 n = mix(vec3(0.0, 1.0, 0.0), vec3(0.7, 0.2, 0.7), skirt);
        vec3 col = shade(albedo, normalize(n), sunLight(vWorldPos, vec3(0.0, 1.0, 0.0)), cityAO(vWorldPos, info));

        // Night: pools of sodium light down the middle of the big roads, a faint wash on the rest.
        float across = exp(-vUv.x * vUv.x * 1.6);
        float pool = 0.62 + 0.38 * cos((vUv.y - 20.0) * (6.2832 / 40.0));
        vec3 sodium = vec3(1.0, 0.56, 0.2);
        col += sodium * uNight * (1.0 - rail) * (1.0 - skirt) * mix(0.07, 0.30 * across * pool, major * (1.0 - uCasing)) * mix(1.0, 1.6, uCasing);

        col = applyFog(col, vWorldPos);
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
      }
    `,
  });
  const casingMaterial = make(true), roadMaterial = make(false);

  const lights = createLightPoints(env, { capacity: 60000, color: [3.0, 1.75, 0.7], size: 7 });
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
      g.setAttribute('aSide', new THREE.BufferAttribute(d.side, 2));
      g.setAttribute('aInfo', new THREE.BufferAttribute(d.info, 4));
      g.setIndex(new THREE.BufferAttribute(d.index, 1));
      // A little larger than the geometry: the casing pass widens it.
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(...d.center), d.radius + PAVEMENT * 2);
      const meshes = [casingMaterial, roadMaterial].map((material, i) => {
        const mesh = new THREE.Mesh(g, material);
        mesh.position.set(origin[0], origin[1], origin[2]);
        mesh.updateMatrix();
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = -31 + i;
        group.add(mesh);
        return mesh;
      });
      tiles.push({ casing: meshes[0], road: meshes[1], geometry: g, all: d.index.length, major: d.majorIndexCount, centre: new THREE.Vector3(...d.center).add(meshes[0].position), radius: d.radius });
    },
    /** @param {number} minorFar distance (m) beyond which class >= 4 roads are hidden; pavements stop at half of it */
    update(camera, minorFar) {
      lights.update();
      for (const t of tiles) {
        const d = centre.copy(t.centre).sub(camera.position).length() - t.radius;
        const far = d > minorFar;
        const count = far ? t.major : t.all;
        t.road.visible = count > 0;
        t.casing.visible = count > 0 && d < minorFar * 0.5;
        t.geometry.setDrawRange(0, count);
      }
    },
  };
}
