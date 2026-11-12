// Builds the five procedural landmarks and puts each one where its OSM footprint was.
// Position and rotation come from landmarks.json (footprint centre and min-area-rectangle angle), except
// where that rectangle does not describe the shape; those two were measured from the raw OSM outline in Phase 3.
import * as THREE from 'three';
import * as burjKhalifa from './burjKhalifa.js';
import * as ainDubai from './ainDubai.js';
import * as cayan from './cayan.js';
import * as burjAlArab from './burjAlArab.js';
import * as museumFuture from './museumFuture.js';

const MODULES = { burjKhalifa, ainDubai, cayan, burjAlArab, museumFuture };
const GROUND_Y = 1.5; // top of the land slab

// east, north in metres; rot = angle of the model's +x axis, counter-clockwise from east.
const PLACEMENT = {
  // Way 446646206: outline centre, wings at 22.5, 142.5 and 262.5 degrees.
  burjKhalifa: { x: 7728.8, north: 5781.3, rot: (22.5 * Math.PI) / 180 },
  // Way 12700546: the mast corner of the footprint; the fabric front faces the shore, 37.6 degrees south of east.
  burjAlArab: { x: -1280.4, north: -367.1, rot: (-37.6 * Math.PI) / 180 },
};

/** Camera presets for the jump chips: bearing (degrees counter-clockwise from east) from the landmark to the camera. */
const VIEWS = {
  burjKhalifa: { bearing: -70, dist: 1500, height: 380, lookAt: 380 },
  ainDubai: { bearing: 192, dist: 620, height: 110, lookAt: 125 },
  cayan: { bearing: 150, dist: 760, height: 230, lookAt: 165 },
  burjAlArab: { bearing: 70, dist: 720, height: 150, lookAt: 150 },
  museumFuture: { bearing: 141, dist: 260, height: 55, lookAt: 42 }, // face-on from the north-west; a tower blocks the other side
};

export function createLandmarks(env, data, beacons) {
  const group = new THREE.Group();
  const items = [];
  const places = {};
  for (const [key, mod] of Object.entries(MODULES)) {
    const lm = data[key];
    if (!lm) continue;
    const place = PLACEMENT[key] || { x: lm.footprint.cx, north: lm.footprint.cy, rot: lm.footprint.angle };
    const item = mod.create(env);
    item.group.position.set(place.x, GROUND_Y, -place.north);
    item.group.rotation.y = place.rot; // local +x -> (cos rot, sin rot) in (east, north)
    item.group.updateMatrixWorld(true);
    group.add(item.group);
    items.push(item);
    for (const b of item.beacons) beacons.add(new THREE.Vector3(...b).applyMatrix4(item.group.matrixWorld).toArray());
    places[key] = { name: lm.name, x: place.x, north: place.north, height: lm.height };
  }

  return {
    object: group,
    places,
    update(dt) {
      for (const item of items) item.update(dt, env);
    },
    /** Camera position and target (scene coordinates) for a landmark's preset view. */
    view(key) {
      const p = places[key], v = VIEWS[key];
      if (!p || !v) return null;
      const a = (v.bearing * Math.PI) / 180;
      return {
        position: new THREE.Vector3(p.x + Math.cos(a) * v.dist, v.height, -(p.north + Math.sin(a) * v.dist)),
        target: new THREE.Vector3(p.x, v.lookAt, -p.north),
      };
    },
  };
}
