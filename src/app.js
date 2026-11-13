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
import { createSunShadow } from './world/sunShadow.js';
import { createClouds } from './world/clouds.js';
import { createLandmarks } from './landmarks/index.js';
import { openCity } from './data/loader.js';
import { createControls } from './camera/controls.js';
import { createTour } from './camera/tour.js';
import { createUI } from './ui/ui.js';
import { createPerf } from './ui/perf.js';
import { parseParams } from './ui/params.js';
import { showFatal } from './ui/fatal.js';
import { createPost } from './post.js';

// ---- Tuning constants: LOD distances and the resolution governor ----
// Everything that decides how far things draw and when the render scale changes, in one place.
// Distances are metres from the camera. Values here are the live ones; the three groups marked "lives in"
// are read by other modules and are listed so a tuning pass knows where to look.
//
// Per quality level (used by frame() below):
//   lodFar    beyond it a tile draws only its >= 40 m buildings (the tallest-first draw range).
//   minorFar  beyond it class >= 4 roads are hidden.
//   plantFar  within it a tile also draws its roof plant (0 = never).
//   props     trees, cars and boats on or off.
//   dpr       device pixel ratio cap, before the governor's scale.
//   bloom     post pipeline with bloom, SSAO, grade and crisp sun shadows (Low renders straight to the canvas).
const QUALITY = {
  high: { dpr: 1.5, bloom: true, lodFar: 7000, minorFar: 5000, plantFar: 2200, props: true },
  low: { dpr: 1, bloom: false, lodFar: 4500, minorFar: 3000, plantFar: 0, props: false },
};
const FOV = 50;
// Palms and trees are drawn into the sun shadow map only while its box is narrower than this (half-width, m).
const TREE_SHADOW_HALF = 1100;
// Lives in src/world/props.js (FAR, metres from the edge of a 2 km cell): palms 1900, trees 1900, cars 1000, boats 6000.
// Lives in src/world/sunShadow.js: shadow map 2048 px; half-width of the box 700..2600 m (0.9 x reach + 300);
//   reach capped at 2800 m (1500 m when looking level); towers-only draw beyond 1400 m, no roof plant.
//   Those two files are not touched in Phase 4B, so their numbers are described here, not imported.
//
// Resolution governor. When frames run long the render size shrinks (the canvas is stretched back up), and
// it creeps up again once there is headroom. This is what keeps the tour smooth on an integrated GPU.
// Every reduction is a trial: if the frame time does not improve, the cause is not the GPU's fill rate (a
// throttled tab, a 30 fps cap, a busy CPU), so the reduction is undone and not tried again for a while.
const GOVERNOR = {
  minScale: 0.5,       // never render below half size
  slowMs: 20.5,        // average frame time above this -> try a smaller scale
  fastMs: 17.6,        // average below this for climbAfterMs -> try a larger scale
  windowMs: 750,       // frames are averaged over this long before a decision
  hitchMs: 250,        // a single frame longer than this (tab switch, tile upload) is ignored
  settleMs: 300,       // after a resize, let it settle before judging
  stepDown: 0.82,      // scale multiplier per reduction
  stepUp: 1.12,        // scale multiplier per climb
  trialGain: 0.88,     // a reduction must bring the average below this fraction, or it is undone
  climbAfterMs: 4500,  // time under fastMs before climbing
  climbHoldMs: 3000,   // wait after a climb before the next
  climbWaitMs: 6000,   // initial wait after a reduction before climbing; grows by climbWaitGrow up to climbWaitMax
  climbWaitGrow: 1.6,
  climbWaitMax: 120000,
  lockMs: 30000,       // after an undone trial, no reductions for this long; doubles up to lockMax
  lockMax: 600000,
};

export function createApp(canvas) {
  const params = parseParams();
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
  scene.add(sky.object, water.object, land.object, roads.object, roads.casters, buildings.object, props.object);
  let traffic = null, landmarks = null;

  const post = createPost(renderer, scene, camera);
  const cityMap = createCityMap(renderer, env);
  const sunShadow = createSunShadow(renderer, env);
  const clouds = createClouds(renderer, env);

  // ---- quality + resize ----
  let level = 'high';
  const res = { enabled: true, scale: 1, sum: 0, n: 0, skip: 0, fast: 0, hold: 0, climbWait: GOVERNOR.climbWaitMs, lock: 0, lockWait: GOVERNOR.lockMs, trial: null };
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
    if (!res.enabled || ms > GOVERNOR.hitchMs) return; // a hitch (tab switch, tile upload) is not a slow frame
    res.hold -= ms;
    res.lock -= ms;
    if (res.skip > 0) { res.skip -= ms; return; } // let a resize settle before judging it
    res.sum += ms;
    res.n++;
    if (res.sum < GOVERNOR.windowMs) return;
    const avg = res.sum / res.n;
    res.sum = res.n = 0;
    const set = (scale) => { res.scale = scale; res.skip = GOVERNOR.settleMs; resize(); };
    if (res.trial) {
      const helped = avg < res.trial.before * GOVERNOR.trialGain;
      if (!helped) {
        res.lock = res.lockWait;
        res.lockWait = Math.min(GOVERNOR.lockMax, res.lockWait * 2);
        set(res.trial.from);
      }
      res.trial = null;
      return;
    }
    res.fast = avg < GOVERNOR.fastMs ? res.fast + GOVERNOR.windowMs : 0;
    if (avg > GOVERNOR.slowMs && res.scale > GOVERNOR.minScale && res.lock <= 0) {
      res.trial = { before: avg, from: res.scale };
      res.fast = 0;
      res.hold = res.climbWait;
      res.climbWait = Math.min(GOVERNOR.climbWaitMax, res.climbWait * GOVERNOR.climbWaitGrow); // each retreat waits longer before climbing again
      set(Math.max(GOVERNOR.minScale, res.scale * GOVERNOR.stepDown));
    } else if (res.fast >= GOVERNOR.climbAfterMs && res.hold <= 0 && res.scale < 1) {
      res.fast = 0;
      res.hold = GOVERNOR.climbHoldMs;
      set(Math.min(1, res.scale * GOVERNOR.stepUp));
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

  // Phones and tablets (coarse pointer or a narrow screen) start in Low; ?q overrides. Reduced motion: no automatic tour.
  const small = window.matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 600;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let autoTour = params.tour && !reducedMotion; // play once when the city has loaded, unless the user has already taken over
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
  const perf = params.perf
    ? createPerf(() => app.stats(), () => res, () => level)
    : null;

  // URL parameters: quality, time of day and camera.
  const startLevel = params.q || (small ? 'low' : null);
  if (startLevel) setQuality(startLevel);
  if (params.t !== null) {
    env.setTime(params.t);
    ui.setTime(params.t);
  }
  if (params.cam) {
    const [x, y, z, tx, ty, tz] = [...params.cam.position, ...params.cam.target];
    camera.position.set(x, y, z);
    controls.target.set(tx, ty, tz);
    camera.lookAt(controls.target);
  }

  // Any input on the scene skips the tour.
  const takeOver = (e) => {
    if (ui.isControl(e.target) || ui.isHudKey(e)) return;
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
  let loaded = false, tourPending = false;
  function frame(now) {
    const last0 = last;
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    if (loaded && now > last) govern(now - last);
    last = now;
    renderer.info.reset();
    env.tick(dt);
    if (tour.playing) tour.update(dt);
    else controls.update(dt);
    const q = QUALITY[level];
    sky.update(camera);
    // Crisp shadows near the camera (High only). Its own pass over buildings, landmarks and trees.
    if (loaded && q.bloom) {
      // Palms and trees cast too, but only when the shadow box is small (camera low and close): from the air
      // their shadows are under a pixel and the pass would draw every tree in view for nothing.
      const trees = q.props && sunShadow.half < TREE_SHADOW_HALF;
      if (trees) props.castOnly(); // props.update() below restores the cars and boats
      const hide = [sky.object, water.object, land.object, roads.object, traffic.object, buildings.beacons.object];
      if (!trees) hide.push(props.object);
      sunShadow.update(scene, camera, hide, buildings, [roads.casters]);
    }
    else env.uniforms.uSunOn.value = 0;
    buildings.update(camera, q.lodFar, q.plantFar);
    props.object.visible = q.props;
    if (q.props) props.update(camera);
    roads.update(camera, q.minorFar);
    if (traffic) traffic.update(dt);
    if (landmarks) landmarks.update(dt);
    cityMap.update();
    clouds.update();
    post.render(env, q.bloom, dt);
    if (perf) perf.tick(now - last0, now);
    if (tourPending) {
      tourPending = false;
      if (autoTour) startTour();
    }
  }
  renderer.setAnimationLoop(frame);

  // ---- data ----
  const ready = (async () => {
    const city = await openCity();
    landmarks = createLandmarks(env, city.landmarks, buildings.beacons);
    traffic = createTraffic(env, city.traffic, city.bridges);
    scene.add(landmarks.object, traffic.object);
    const focus = [camera.position.x, -camera.position.z]; // the start pose, or ?cam
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
    if (result.total && result.failed === result.total) throw new Error('every data file failed to load');
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
    tourPending = true; // the tour starts at the end of the first frame that has the city in it
    return result;
  })().catch((err) => {
    console.error(err);
    showFatal('Could not load the city data.', 'Run "npm run data:build" if you are working from the source, then reload. Details are in the console.');
    throw err;
  });

  const app = {
    renderer, scene, camera, env, controls, tour, buildings, roads, props, ready, frame, cityMap, sunShadow, res, post,
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
  return app;
}
