// Phase 1 placeholder: proves the toolchain and the coordinate system.
// Draws each zone bbox and a pole at every landmark anchor. Phase 3 replaces this file.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BBOX, LANDMARKS, project, toScene } from './shared/config.js';

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f17);

const camera = new THREE.PerspectiveCamera(50, 1, 5, 60000);
camera.position.set(-9000, 9000, 14000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.GridHelper(24000, 12, 0x33405a, 0x1b2333));

const zoneColors = { world: 0x556070, marina: 0x4fc3f7, palm: 0xffd54f, downtown: 0xff8a65, baa: 0xba68c8 };
for (const [key, color] of Object.entries(zoneColors)) {
  const [s, w, n, e] = BBOX[key];
  const corners = [[s, w], [s, e], [n, e], [n, w]].map(([lat, lon]) => new THREE.Vector3(...toScene(...project(lat, lon), 2)));
  const geometry = new THREE.BufferGeometry().setFromPoints(corners);
  scene.add(new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color })));
}

for (const lm of Object.values(LANDMARKS)) {
  const pole = new THREE.Mesh(new THREE.BoxGeometry(60, lm.height, 60), new THREE.MeshBasicMaterial({ color: 0xf2ede4 }));
  pole.position.set(...toScene(...project(lm.lat, lm.lon), lm.height / 2));
  scene.add(pole);
}

function resize() {
  const { innerWidth: w, innerHeight: h } = window;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
