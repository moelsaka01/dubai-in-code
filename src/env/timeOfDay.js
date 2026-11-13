// Time of day. One parameter t in [0, 1] (noon -> night) is interpolated between keyframes
// into a single set of uniforms that every material shares by reference.
import * as THREE from 'three';

const DEG = Math.PI / 180;
/** sRGB hex -> linear colour, scaled. */
const S = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
/** Linear RGB given directly (light intensities). */
const L = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

// el/az: sun elevation and compass azimuth in degrees. fog: haze density per metre at sea level.
const KEYS = [
  { t: 0.0, el: 70, az: 205, zenith: S(0x2e6bbf), horizon: S(0xbcd3e4), glow: S(0xfff0d0, 0.1), sun: L(0.8, 0.77, 0.7),
    ambSky: L(0.16, 0.21, 0.3), ambGround: L(0.17, 0.15, 0.1), water: S(0x0c6a80), fog: 5.0e-5, exposure: 0.78, night: 0, lit: 0, bloom: 0, stars: 0 },
  { t: 0.3, el: 33, az: 255, zenith: S(0x2f68b8), horizon: S(0xc4d4de), glow: S(0xffe2b0, 0.25), sun: L(0.82, 0.76, 0.64),
    ambSky: L(0.15, 0.19, 0.28), ambGround: L(0.16, 0.13, 0.09), water: S(0x0d6078), fog: 6.0e-5, exposure: 0.82, night: 0, lit: 0.02, bloom: 0, stars: 0 },
  // Golden hour and sunset: a strong warm sun against a cool, dim sky fill. The contrast between the two is what
  // gives the evening its definition; with a warm fill everything turns one shade of orange.
  { t: 0.5, el: 8, az: 285, zenith: S(0x3d6aa6), horizon: S(0xf2b274), glow: S(0xff9a40, 0.9), sun: L(1.3, 0.76, 0.36),
    ambSky: L(0.08, 0.11, 0.19), ambGround: L(0.085, 0.07, 0.055), water: S(0x1d5068), fog: 5.5e-5, exposure: 0.92, night: 0.05, lit: 0.04, bloom: 0.14, stars: 0 },
  { t: 0.64, el: 2.5, az: 291, zenith: S(0x2a447e), horizon: S(0xee8a50), glow: S(0xff6a30, 1.0), sun: L(1.05, 0.46, 0.19),
    ambSky: L(0.055, 0.075, 0.145), ambGround: L(0.06, 0.045, 0.04), water: S(0x1a3a58), fog: 6.0e-5, exposure: 1.05, night: 0.35, lit: 0.22, bloom: 0.2, stars: 0 },
  { t: 0.75, el: -6, az: 296, zenith: S(0x0e1c44), horizon: S(0x5a4f78), glow: S(0xff5a30, 0.45), sun: L(0.3, 0.12, 0.05),
    ambSky: L(0.04, 0.055, 0.11), ambGround: L(0.04, 0.032, 0.03), water: S(0x0a1a38), fog: 7.0e-5, exposure: 1.1, night: 0.8, lit: 0.45, bloom: 0.32, stars: 0.25 },
  // Night: the haze over the city is lit from below, so the horizon is a dull amber and distance fades into it.
  { t: 1.0, el: -30, az: 310, zenith: S(0x060a16), horizon: S(0x40301f), glow: S(0x000000), sun: L(0, 0, 0),
    ambSky: L(0.028, 0.036, 0.058), ambGround: L(0.06, 0.042, 0.026), water: S(0x03080f), fog: 8.0e-5, exposure: 1.15, night: 1, lit: 0.55, bloom: 0.42, stars: 1 },
];
const SCALARS = ['el', 'az', 'fog', 'exposure', 'night', 'lit', 'bloom', 'stars'];
const COLORS = ['zenith', 'horizon', 'glow', 'sun', 'ambSky', 'ambGround', 'water'];
const MOON_COLOR = L(0.035, 0.045, 0.07);
const MOON = { az: 150, el: 48 };

/** Compass azimuth + elevation -> unit vector in scene space (x east, y up, z = -north). */
function direction(azDeg, elDeg, out) {
  const az = azDeg * DEG, el = elDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

const smooth = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** 1x1 float texture: what the shadow and city maps read as until src/world/cityMap.js has rendered them. */
function flatTexture(v) {
  const t = new THREE.DataTexture(new Float32Array([v, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
}

export function createEnv() {
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: direction(MOON.az, MOON.el, new THREE.Vector3()) },
    uSunDisc: { value: new THREE.Color() },
    uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    uLightColor: { value: new THREE.Color() },
    uAmbSky: { value: new THREE.Color() },
    uAmbGround: { value: new THREE.Color() },
    uSkyZenith: { value: new THREE.Color() },
    uSkyHorizon: { value: new THREE.Color() },
    uSkyGlow: { value: new THREE.Color() },
    uWaterDeep: { value: new THREE.Color() },
    uFogDensity: { value: 0 },
    uNight: { value: 0 },
    uLitFraction: { value: 0 },
    uStars: { value: 0 },
    uShadowMap: { value: flatTexture(-1000) },
    uCityMap: { value: flatTexture(0) },
    uShadowOn: { value: 0 },
    uSunMap: { value: null }, // set by src/world/sunShadow.js before the first frame
    uSunMatrix: { value: new THREE.Matrix4() },
    uSunTexel: { value: 1 },
    uSunOn: { value: 0 },
    uCloudMap: { value: flatTexture(0) },
    uPixelScale: { value: 1000 }, // pixels per metre at 1 m distance; set by the app on resize
  };
  const cur = {};
  for (const k of COLORS) cur[k] = new THREE.Color();

  const env = {
    t: -1,
    night: 0,
    exposure: 1,
    bloom: 0,
    shadow: 0,
    sunElevation: 0,
    uniforms,
    /** Advance the animation clock. */
    tick(dt) {
      uniforms.uTime.value += dt;
    },
    setTime(t) {
      t = Math.min(1, Math.max(0, t));
      if (t === env.t) return;
      env.t = t;
      let i = 0;
      while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
      const a = KEYS[i], b = KEYS[i + 1];
      const f = (t - a.t) / (b.t - a.t);
      for (const k of SCALARS) cur[k] = a[k] + (b[k] - a[k]) * f;
      for (const k of COLORS) cur[k].copy(a[k]).lerp(b[k], f);

      // Key light: the sun while it is up, a dim moon afterwards. Both are at zero where they hand over (-4 deg).
      const sunAmt = smooth(-4, 3, cur.el);
      const moonAmt = smooth(-4, -10, cur.el);
      direction(cur.az, cur.el, uniforms.uSunDir.value);
      if (cur.el > -4) {
        direction(cur.az, Math.max(cur.el, 3), uniforms.uLightDir.value);
        uniforms.uLightColor.value.copy(cur.sun).multiplyScalar(sunAmt);
      } else {
        uniforms.uLightDir.value.copy(uniforms.uMoonDir.value);
        uniforms.uLightColor.value.copy(MOON_COLOR).multiplyScalar(moonAmt);
      }
      uniforms.uSunDisc.value.copy(cur.sun).multiplyScalar(14 * smooth(-2, 4, cur.el));
      uniforms.uAmbSky.value.copy(cur.ambSky);
      uniforms.uAmbGround.value.copy(cur.ambGround);
      uniforms.uSkyZenith.value.copy(cur.zenith);
      uniforms.uSkyHorizon.value.copy(cur.horizon);
      uniforms.uSkyGlow.value.copy(cur.glow);
      uniforms.uWaterDeep.value.copy(cur.water);
      uniforms.uFogDensity.value = cur.fog;
      uniforms.uNight.value = cur.night;
      uniforms.uLitFraction.value = cur.lit;
      uniforms.uStars.value = cur.stars;
      // Shadows fade out as the sun reaches the horizon; the moon casts none.
      env.shadow = smooth(0, 3, cur.el);
      env.sunElevation = cur.el;
      env.night = cur.night;
      env.exposure = cur.exposure;
      env.bloom = cur.bloom;
    },
  };
  env.setTime(0.5);
  return env;
}
