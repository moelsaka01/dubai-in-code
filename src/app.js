// App shell: renderer, scene, quality state, render loop, and the wiring between data, world, camera and UI.
import * as THREE from 'three';
import { createEnv } from './env/timeOfDay.js';
import { createSky } from './world/sky.js';
import { createWater } from './world/water.js';
import { createLand } from './world/land.js';
import { createBuildings } from './world/buildings.js';
import { createRoads } from './world/roads.js';
import { createTraffic } from './world/traffic.js';
import { createProps } from './world/props.js';
import { createCityMap } from './world/cityMap.js';
import { createLandmarks } from './landmarks/index.js';
import { openCity } from './data/loader.js';
import { createControls } from './camera/controls.js';
import { createTour } from './camera/tour.js';
import { createUI } from './ui/ui.js';
import { createPost } from './post.js';

// lodFar: beyond it a tile draws only its >= 40 m buildings. minorFar: beyond it class >= 4 roads are hidden.
// plantFar: within it a tile also draws its roof plant. props: trees, cars and boats.
const QUALITY = {
  high: { dpr: 1.5, bloom: true, lodFar: 7000, minorFar: 5000, plantFar: 2200, props: true },
  low: { dpr: 1, bloom: false, lodFar: 4500, minorFar: 3000, plantFar: 0, props: false },
};
const FOV = 50;
// Resolution scaling: when frames run long the render size shrinks (the canvas is stretched back up), and it
// creeps up again once there is headroom. This is what keeps the tour smooth on an integrated GPU.
// Every reduction is a trial: if the frame time does not improve, the cause is not the GPU's fill rate (a
// throttled tab, a 30 fps cap, a busy CPU), so the reduction is undone and not tried again for a while.
const MIN_SCALE = 0.5;
const SLOW_MS = 20.5, FAST_MS = 17.6, WINDOW_MS = 750;

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
  const props = createProps(env);
  scene.add(sky.object, water.object, land.object, roads.object, buildings.object, props.object);
  let traffic = null, landmarks = null;

  const post = createPost(renderer, scene, camera);
  const cityMap = createCityMap(renderer, env);

  // ---- quality + resize ----
  let level = 'high';
  const res = { enabled: true, scale: 1, sum: 0, n: 0, skip: 0, fast: 0, hold: 0, climbWait: 6000, lock: 0, lockWait: 30000, trial: null };
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, QUALITY[level].dpr) * res.scale;
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
  /** Feed one frame time (ms) to the resolution governor. */
  function govern(ms) {
    if (!res.enabled || ms > 250) return; // a hitch (tab switch, tile upload) is not a slow frame
    res.hold -= ms;
    res.lock -= ms;
    if (res.skip > 0) { res.skip -= ms; return; } // let a resize settle before judging it
    res.sum += ms;
    res.n++;
    if (res.sum < WINDOW_MS) return;
    const avg = res.sum / res.n;
    res.sum = res.n = 0;
    const set = (scale) => { res.scale = scale; res.skip = 300; resize(); };
    if (res.trial) {
      const helped = avg < res.trial.before * 0.88;
      if (!helped) {
        res.lock = res.lockWait;
        res.lockWait = Math.min(600000, res.lockWait * 2);
        set(res.trial.from);
      }
      res.trial = null;
      return;
    }
    res.fast = avg < FAST_MS ? res.fast + WINDOW_MS : 0;
    if (avg > SLOW_MS && res.scale > MIN_SCALE && res.lock <= 0) {
      res.trial = { before: avg, from: res.scale };
      res.fast = 0;
      res.hold = res.climbWait;
      res.climbWait = Math.min(120000, res.climbWait * 1.6); // each retreat waits longer before climbing again
      set(Math.max(MIN_SCALE, res.scale * 0.82));
    } else if (res.fast >= 4500 && res.hold <= 0 && res.scale < 1) {
      res.fast = 0;
      res.hold = 3000;
      set(Math.min(1, res.scale * 1.12));
    }
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
  let loaded = false;
  function frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    if (loaded && now > last) govern(now - last);
    last = now;
    renderer.info.reset();
    env.tick(dt);
    if (tour.playing) tour.update(dt);
    else controls.update(dt);
    const q = QUALITY[level];
    sky.update(camera);
    buildings.update(camera, q.lodFar, q.plantFar);
    props.object.visible = q.props;
    if (q.props) props.update(camera);
    roads.update(camera, q.minorFar);
    if (traffic) traffic.update(dt);
    if (landmarks) landmarks.update(dt);
    cityMap.update();
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
      onLand: (m) => {
        land.setData(m);
        props.add(m.props);
      },
      onTile: (m) => {
        buildings.addTile(m.origin, m.buildings);
        roads.addTile(m.origin, m.roads);
        props.add(m.props);
      },
      onProgress: (f) => ui.setProgress(f),
    });
    const count = city.manifest.counts.buildings.toLocaleString('en-US');
    ui.setStatus(result.failed
      ? `${result.failed} of ${result.total} data files failed to load. See the console.`
      : `${count} buildings from OpenStreetMap. Drag to orbit, scroll to zoom, WASD to fly.`);
    // Height, shadow and occlusion maps: every tile at full detail, without the layers that are not ground or buildings.
    buildings.update(camera, Infinity);
    cityMap.render(scene, [sky.object, water.object, roads.object, traffic.object, buildings.beacons.object, props.object]);
    props.addBoats(cityMap.waterMask());
    props.build();
    loaded = true;
    last = performance.now();
    if (autoTour) startTour();
    return result;
  })().catch((err) => {
    console.error(err);
    ui.setStatus('Could not load the city data. Run "npm run data:build", then reload.');
    throw err;
  });

  return {
    renderer, scene, camera, env, controls, tour, buildings, roads, props, ready, frame, cityMap, res, post,
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
