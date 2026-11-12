// App shell: renderer, scene, quality state, render loop, and the wiring between data, world, camera and UI.
import * as THREE from 'three';
import { createEnv } from './env/timeOfDay.js';
import { createSky } from './world/sky.js';
import { createWater } from './world/water.js';
import { createLand } from './world/land.js';
import { createBuildings } from './world/buildings.js';
import { createRoads } from './world/roads.js';
import { createTraffic } from './world/traffic.js';
import { createLandmarks } from './landmarks/index.js';
import { openCity } from './data/loader.js';
import { createControls } from './camera/controls.js';
import { createTour } from './camera/tour.js';
import { createUI } from './ui/ui.js';
import { createPost } from './post.js';

// lodFar: beyond it a tile draws only its >= 40 m buildings. minorFar: beyond it class >= 4 roads are hidden.
const QUALITY = {
  high: { dpr: 1.5, bloom: true, lodFar: 7000, minorFar: 5000 },
  low: { dpr: 1, bloom: false, lodFar: 4500, minorFar: 3000 },
};
const FOV = 50;

export function createApp(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.info.autoReset = false; // count a whole frame, including the post passes
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 5, 60000);

  const env = createEnv();
  const sky = createSky(env);
  const water = createWater(env);
  const land = createLand(env);
  const buildings = createBuildings(env);
  const roads = createRoads(env);
  scene.add(sky.object, water.object, land.object, roads.object, buildings.object);
  let traffic = null, landmarks = null;

  const post = createPost(renderer, scene, camera);

  // ---- quality + resize ----
  let level = 'high';
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, QUALITY[level].dpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    post.setSize(w, h, dpr);
    env.uniforms.uPixelScale.value = (h * dpr) / (2 * Math.tan((FOV * Math.PI) / 360));
  }
  function setQuality(next) {
    if (!QUALITY[next]) return;
    level = next;
    ui.setQuality(level);
    resize();
  }

  // ---- camera: tour and free controls ----
  const controls = createControls(camera, canvas);
  const tour = createTour(camera, {
    onTime(t) {
      env.setTime(t);
      ui.setTime(t);
    },
    onEnd(look) {
      controls.target.copy(look);
      controls.enabled = true;
      ui.setTourPlaying(false);
    },
  });
  camera.position.copy(tour.first.position);
  controls.target.copy(tour.first.look);
  camera.lookAt(tour.first.look);

  let autoTour = true; // play once when the city has loaded, unless the user has already taken over
  function startTour() {
    controls.enabled = false;
    tour.start();
    ui.setTourPlaying(true);
  }
  function stopTour() {
    autoTour = false;
    if (!tour.playing) return;
    controls.target.copy(tour.stop());
    controls.enabled = true;
    ui.setTourPlaying(false);
  }

  const ui = createUI({
    onTime(t) {
      stopTour();
      env.setTime(t);
    },
    onTour() {
      if (tour.playing) stopTour();
      else startTour();
    },
    onQuality: setQuality,
    onLandmark(key) {
      const view = landmarks && landmarks.view(key);
      if (!view) return;
      stopTour();
      controls.flyTo(view.position, view.target);
    },
  });
  ui.setTime(env.t);

  // Any input on the scene skips the tour.
  const takeOver = (e) => {
    if (ui.isControl(e.target)) return;
    stopTour();
    controls.cancelFlight();
  };
  canvas.addEventListener('pointerdown', takeOver);
  canvas.addEventListener('wheel', takeOver, { passive: true });
  window.addEventListener('keydown', takeOver);
  window.addEventListener('resize', resize);
  resize();

  // ---- loop ----
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    renderer.info.reset();
    env.tick(dt);
    if (tour.playing) tour.update(dt);
    else controls.update(dt);
    const q = QUALITY[level];
    sky.update(camera);
    buildings.update(camera, q.lodFar);
    roads.update(camera, q.minorFar);
    if (traffic) traffic.update(dt);
    if (landmarks) landmarks.update(dt);
    post.render(env, q.bloom);
  }
  renderer.setAnimationLoop(frame);

  // ---- data ----
  const ready = (async () => {
    const city = await openCity();
    landmarks = createLandmarks(env, city.landmarks, buildings.beacons);
    traffic = createTraffic(env, city.traffic);
    scene.add(landmarks.object, traffic.object);
    const focus = [tour.first.position.x, -tour.first.position.z];
    const result = await city.stream({
      focus,
      onLand: (m) => land.setData(m),
      onTile: (m) => {
        buildings.addTile(m.origin, m.buildings);
        roads.addTile(m.origin, m.roads);
      },
      onProgress: (f) => ui.setProgress(f),
    });
    const count = city.manifest.counts.buildings.toLocaleString('en-US');
    ui.setStatus(result.failed
      ? `${result.failed} of ${result.total} data files failed to load. See the console.`
      : `${count} buildings from OpenStreetMap. Drag to orbit, scroll to zoom, WASD to fly.`);
    if (autoTour) startTour();
    return result;
  })().catch((err) => {
    console.error(err);
    ui.setStatus('Could not load the city data. Run "npm run data:build", then reload.');
    throw err;
  });

  return {
    renderer, scene, camera, env, controls, tour, buildings, roads, ready, frame,
    get landmarks() { return landmarks; },
    setQuality,
    get quality() { return level; },
    /** Numbers for checks and the Phase 4 perf overlay. */
    stats() {
      const i = renderer.info;
      return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, programs: i.programs ? i.programs.length : 0,
        tiles: buildings.tileCount, streetLights: roads.lights.count, beacons: buildings.beacons.count, cars: traffic ? traffic.count : 0 };
    },
  };
}
