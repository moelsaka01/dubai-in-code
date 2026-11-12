// Building tiles: one mesh per tile, one shared material, LOD by index draw range.
// The worker sorts each tile tallest-first, so a far tile draws only its >= 40 m buildings.
import * as THREE from 'three';
import { buildingVertex, buildingFragment } from '../shaders/building.glsl.js';
import { createLightPoints } from './lightPoints.js';

export function createBuildings(env) {
  const group = new THREE.Group();
  const material = new THREE.ShaderMaterial({
    uniforms: { ...env.uniforms },
    vertexShader: buildingVertex,
    fragmentShader: buildingFragment,
  });
  // Red aviation beacons on everything >= 150 m (positions come from the worker, landmarks add their own).
  const beacons = createLightPoints(env, { capacity: 2048, color: [3.0, 0.12, 0.06], size: 9, blink: 1 });
  group.add(beacons.object);

  const tiles = [];
  const centre = new THREE.Vector3();

  return {
    object: group,
    beacons,
    get tileCount() { return tiles.length; },
    addTile(origin, d) {
      beacons.add(d.beacons);
      if (!d.index.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
      g.setAttribute('aNormal', new THREE.BufferAttribute(d.normal, 4, true));
      g.setAttribute('aUv', new THREE.BufferAttribute(d.uv, 2));
      g.setAttribute('aColor', new THREE.BufferAttribute(d.color, 4, true));
      g.setIndex(new THREE.BufferAttribute(d.index, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(...d.center), d.radius);
      const mesh = new THREE.Mesh(g, material);
      mesh.position.set(origin[0], origin[1], origin[2]);
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      tiles.push({ mesh, all: d.index.length, tall: d.tallIndexCount, centre: new THREE.Vector3(...d.center).add(mesh.position), radius: d.radius });
    },
    /** @param {number} lodFar distance (m) beyond which a tile shows only its tall buildings */
    update(camera, lodFar) {
      beacons.update();
      for (const t of tiles) {
        const far = centre.copy(t.centre).sub(camera.position).length() - t.radius > lodFar;
        const count = far ? t.tall : t.all;
        t.mesh.visible = count > 0;
        t.mesh.geometry.setDrawRange(0, count);
      }
    },
  };
}
