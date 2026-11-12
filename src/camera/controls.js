// Free camera: OrbitControls with damping, WASD / arrow keys that fly the orbit target over the ground,
// a ground clamp, and a short eased flight used by the landmark chips.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const LIMIT = 14000; // the target stays inside the built area
const MIN_CAMERA_Y = 8;
const KEYS = {
  KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};

export function createControls(camera, dom) {
  const orbit = new OrbitControls(camera, dom);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.maxPolarAngle = Math.PI * 0.495;
  orbit.minDistance = 40;
  orbit.maxDistance = 22000;
  orbit.zoomSpeed = 1.2;

  const down = new Set();
  const onKey = (e) => {
    if (!(e.code in KEYS) || e.target instanceof HTMLInputElement) return;
    if (e.type === 'keydown') down.add(e.code);
    else down.delete(e.code);
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', () => down.clear());

  const forward = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
  let flight = null;

  return {
    orbit,
    get target() { return orbit.target; },
    set enabled(v) { orbit.enabled = v; if (!v) { down.clear(); flight = null; } },
    get enabled() { return orbit.enabled; },
    /** Ease the camera to a new position and target. */
    flyTo(position, target, seconds = 1.8) {
      flight = { t: 0, seconds, p0: camera.position.clone(), q0: orbit.target.clone(), p1: position.clone(), q1: target.clone() };
    },
    cancelFlight() { flight = null; },
    update(dt) {
      if (!orbit.enabled) return;
      if (flight) {
        flight.t = Math.min(1, flight.t + dt / flight.seconds);
        const k = flight.t * flight.t * (3 - 2 * flight.t);
        camera.position.lerpVectors(flight.p0, flight.p1, k);
        // Arc over the city instead of cutting through it.
        camera.position.y += Math.sin(Math.PI * k) * Math.min(600, flight.p0.distanceTo(flight.p1) * 0.15);
        orbit.target.lerpVectors(flight.q0, flight.q1, k);
        camera.lookAt(orbit.target);
        if (flight.t >= 1) flight = null;
        return;
      }
      if (down.size) {
        let mx = 0, mz = 0;
        for (const code of down) { mx += KEYS[code][0]; mz += KEYS[code][1]; }
        camera.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
        forward.normalize();
        right.set(-forward.z, 0, forward.x);
        const speed = Math.max(80, camera.position.distanceTo(orbit.target) * 0.9);
        move.set(0, 0, 0).addScaledVector(forward, mz).addScaledVector(right, mx);
        if (move.lengthSq() > 0) {
          move.normalize().multiplyScalar(speed * dt);
          orbit.target.add(move);
          camera.position.add(move);
        }
      }
      const t = orbit.target;
      const cx = Math.min(LIMIT, Math.max(-LIMIT, t.x)), cz = Math.min(LIMIT, Math.max(-LIMIT, t.z));
      if (cx !== t.x || cz !== t.z) {
        camera.position.x += cx - t.x;
        camera.position.z += cz - t.z;
        t.x = cx;
        t.z = cz;
      }
      t.y = Math.min(900, Math.max(0, t.y));
      orbit.update();
      if (camera.position.y < MIN_CAMERA_Y) camera.position.y = MIN_CAMERA_Y;
    },
  };
}
