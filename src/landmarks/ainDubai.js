// Ain Dubai (250 m). Rim torus, 48 instanced capsules that stay level, cable spokes as line segments,
// a hub and four tapered legs in two A-frames. Local frame: the wheel lies in the XY plane (axle along z),
// base at y = 0.
import * as THREE from 'three';
import { GeoBuilder, landmarkMaterial, lineMaterial, strut } from './common.js';

const HUB_Y = 126;
const RIM_R = 118;
const CAPSULE_R = 123;
const CAPSULES = 48;
const SPOKES = 48; // per side of the hub
const PERIOD = 150; // seconds per turn (the real wheel takes 38 minutes)

export function create(env) {
  // Static structure: rim, hub, legs. The rim does not need to turn; its LED pattern moves instead.
  const gb = new GeoBuilder();
  const up = new THREE.Matrix4().makeTranslation(0, HUB_Y, 0);
  for (const z of [-3.2, 3.2]) {
    const rim = new THREE.TorusGeometry(RIM_R, 1.9, 8, 96);
    gb.add(rim, new THREE.Matrix4().makeTranslation(0, HUB_Y, z));
    rim.dispose();
  }
  const hub = new THREE.CylinderGeometry(6.5, 6.5, 40, 16);
  hub.rotateX(Math.PI / 2);
  gb.add(hub, up);
  hub.dispose();
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = strut([sx * 58, 0, sz * 30], [sx * 3, HUB_Y, sz * 17], 4.2, 2.6, 10);
      gb.add(leg);
      leg.dispose();
    }
  }

  const structure = landmarkMaterial(env, {
    body: /* glsl */ `
      vec2 q = vLocal.xy - vec2(0.0, ${HUB_Y.toFixed(1)});
      albedo = vec3(0.78, 0.80, 0.82);
      gloss = 0.15;
      if (abs(vLocal.z) < 6.0 && abs(length(q) - ${RIM_R.toFixed(1)}) < 4.0) {
        // LED rim: colour drifts around the wheel, a brighter band chases along it.
        float a = atan(q.y, q.x);
        float turn = a / 6.2832;
        vec3 hue = 0.5 + 0.5 * cos(6.2832 * (turn + uTime * 0.02 + vec3(0.0, 0.33, 0.67)));
        float chase = 0.5 + 0.5 * sin(a * 12.0 - uTime * 1.2);
        float segment = step(0.15, fract(turn * 192.0));
        emissive = hue * (0.35 + 0.65 * chase) * segment * 1.8 * uNight;
      } else {
        emissive = vec3(0.50, 0.58, 0.80) * 0.10 * uNight; // floodlit legs
      }
    `,
  });

  const capsuleGeo = new THREE.CapsuleGeometry(2.7, 6.5, 4, 10);
  capsuleGeo.rotateX(Math.PI / 2); // long axis parallel to the axle
  const capsuleMat = landmarkMaterial(env, {
    body: /* glsl */ `
      float frame = smoothstep(0.30, 0.42, abs(fract(vLocal.z / 2.2) - 0.5));
      albedo = mix(vec3(0.10, 0.14, 0.18), vec3(0.85), frame);
      gloss = mix(0.85, 0.2, frame);
      emissive = vec3(1.0, 0.86, 0.62) * (1.0 - frame) * 0.9 * uNight;
    `,
  });
  const capsules = new THREE.InstancedMesh(capsuleGeo, capsuleMat, CAPSULES);
  capsules.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  capsules.frustumCulled = false;

  const pts = [];
  for (let i = 0; i < SPOKES; i++) {
    const a = (i / SPOKES) * 2 * Math.PI;
    for (const z of [-7, 7]) {
      // Each cable leaves one end of the hub and lands on the rim a little ahead: the crossing pattern.
      const b = a + (z > 0 ? 0.12 : -0.12);
      pts.push(3 * Math.cos(a), 3 * Math.sin(a), z, RIM_R * Math.cos(b), RIM_R * Math.sin(b), z > 0 ? 3.2 : -3.2);
    }
  }
  const spokeGeo = new THREE.BufferGeometry();
  spokeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const spokes = new THREE.LineSegments(spokeGeo, lineMaterial(env, [0.55, 0.57, 0.6]));
  spokes.position.y = HUB_Y;

  const group = new THREE.Group();
  group.add(new THREE.Mesh(gb.build(), structure), capsules, spokes);

  const m = new THREE.Matrix4();
  let angle = 0;
  function place() {
    for (let i = 0; i < CAPSULES; i++) {
      const a = angle + (i / CAPSULES) * 2 * Math.PI;
      m.makeTranslation(CAPSULE_R * Math.cos(a), HUB_Y + CAPSULE_R * Math.sin(a), 0);
      capsules.setMatrixAt(i, m);
    }
    capsules.instanceMatrix.needsUpdate = true;
    spokes.rotation.z = angle;
  }
  place();

  return {
    group,
    beacons: [],
    update(dt) {
      angle = (angle + (dt * 2 * Math.PI) / PERIOD) % (2 * Math.PI);
      place();
    },
  };
}
