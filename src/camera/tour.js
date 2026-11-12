// The intro fly-through. Position and look-at run on two Catmull-Rom splines that share one parameter;
// keyframe times are mapped to that parameter with a monotone cubic, so speed changes smoothly and the
// camera starts and ends at rest. The tour also drives time of day from golden hour into night.
import * as THREE from 'three';

/** (east, north, height) in metres -> scene vector. */
const P = (e, n, h) => new THREE.Vector3(e, h, -n);

// `at` is seconds from the start.
export const TOUR_KEYS = [
  { at: 0, pos: P(-9700, -6250, 110), look: P(-7432, -7195, 125) }, // offshore of Bluewaters: Ain Dubai, JBR behind
  { at: 5, pos: P(-8350, -8150, 290), look: P(-6600, -7400, 110) }, // swing round the island toward the Marina
  { at: 9, pos: P(-6750, -7800, 390), look: P(-5276, -6442, 190) }, // up the Marina toward Cayan Tower
  { at: 13, pos: P(-5800, -6450, 410), look: P(-5700, -4700, 40) }, // past Cayan, turning to the Palm
  { at: 17, pos: P(-5250, -4750, 560), look: P(-7300, -2300, 0) }, // climb over the trunk toward Atlantis
  { at: 21, pos: P(-5700, -2650, 620), look: P(-1280, -367, 150) }, // off the crown, turn down the coast
  { at: 27, pos: P(-2350, 280, 190), look: P(-1250, -380, 160) }, // past Burj Al Arab on the sea side
  { at: 30, pos: P(-350, -1450, 320), look: P(2388, -48, 60) }, // inland to Sheikh Zayed Road
  { at: 35, pos: P(2950, 750, 340), look: P(7729, 5781, 350) }, // along SZR, Burj Khalifa ahead
  { at: 40, pos: P(6250, 4250, 290), look: P(7729, 5781, 380) }, // into Downtown
  { at: 44, pos: P(7950, 4950, 220), look: P(7729, 5781, 330) }, // low over the fountain lake
  { at: 49, pos: P(8800, 5500, 430), look: P(7729, 5781, 400) }, // rising orbit
  { at: 54, pos: P(8550, 6750, 640), look: P(7729, 5781, 420) }, // ends high, the tower against the night skyline
];
export const TOUR_SECONDS = TOUR_KEYS[TOUR_KEYS.length - 1].at;
const TIME_START = 0.5, TIME_END = 1.0; // golden hour -> night

const posCurve = new THREE.CatmullRomCurve3(TOUR_KEYS.map((k) => k.pos), false, 'centripetal');
const lookCurve = new THREE.CatmullRomCurve3(TOUR_KEYS.map((k) => k.look), false, 'centripetal');

// Slopes (keyframes per second) at each keyframe for the time -> parameter map; zero at both ends.
const slopes = TOUR_KEYS.map((k, i) => (i === 0 || i === TOUR_KEYS.length - 1 ? 0 : 2 / (TOUR_KEYS[i + 1].at - TOUR_KEYS[i - 1].at)));

/** Seconds -> spline parameter in [0, 1]. Cubic Hermite through (at_i, i); monotone for these slopes. */
function paramAt(seconds) {
  const n = TOUR_KEYS.length;
  if (seconds <= 0) return 0;
  if (seconds >= TOUR_SECONDS) return 1;
  let i = 0;
  while (i < n - 2 && seconds > TOUR_KEYS[i + 1].at) i++;
  const h = TOUR_KEYS[i + 1].at - TOUR_KEYS[i].at;
  const s = (seconds - TOUR_KEYS[i].at) / h;
  const s2 = s * s, s3 = s2 * s;
  const y = (2 * s3 - 3 * s2 + 1) * i + (s3 - 2 * s2 + s) * h * slopes[i] + (-2 * s3 + 3 * s2) * (i + 1) + (s3 - s2) * h * slopes[i + 1];
  return y / (n - 1);
}

/** Camera pose at a given second of the tour. Exported so scripts can check the route. */
export function tourPose(seconds, position = new THREE.Vector3(), look = new THREE.Vector3()) {
  const u = paramAt(seconds);
  posCurve.getPoint(u, position);
  lookCurve.getPoint(u, look);
  return { position, look };
}

export function tourTime(seconds) {
  const k = Math.min(1, Math.max(0, (seconds / TOUR_SECONDS - 0.04) / 0.84));
  return TIME_START + (TIME_END - TIME_START) * k * k * (3 - 2 * k);
}

export function createTour(camera, { onTime, onEnd }) {
  const look = new THREE.Vector3();
  let seconds = 0;
  const tour = {
    playing: false,
    /** Where the camera sits before the tour starts: tiles load nearest to this point first. */
    first: { position: TOUR_KEYS[0].pos.clone(), look: TOUR_KEYS[0].look.clone() },
    start() {
      seconds = 0;
      tour.playing = true;
      tour.apply();
    },
    /** Stop where we are. Returns the point the camera is looking at, for the free controls to orbit. */
    stop() {
      tour.playing = false;
      return look.clone();
    },
    apply() {
      tourPose(seconds, camera.position, look);
      camera.lookAt(look);
      onTime(tourTime(seconds));
    },
    update(dt) {
      if (!tour.playing) return;
      seconds += dt;
      tour.apply();
      if (seconds >= TOUR_SECONDS) {
        tour.playing = false;
        onEnd(look.clone());
      }
    },
  };
  return tour;
}
