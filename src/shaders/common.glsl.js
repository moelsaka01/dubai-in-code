// Shared GLSL: environment uniforms, sky colour, lighting, city shadow / occlusion maps, height fog.
// Every material includes COMMON in its fragment shader, so the whole scene shifts together with time of day.

/** Uniform declarations. The values live in one object (src/env/timeOfDay.js) shared by reference. */
export const ENV_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunDisc;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGlow;
uniform vec3 uWaterDeep;
uniform float uFogDensity;
uniform float uNight;
uniform float uLitFraction;
uniform float uStars;
uniform sampler2D uShadowMap; // r: height (m) below which a point is in the sun's shadow
uniform sampler2D uCityMap;   // r: nearby building height / 510, g: land blur (shore), b: built density, a: wide density
uniform float uShadowOn;
`;

export const COMMON = /* glsl */ `
${ENV_UNIFORMS}

const float FOG_FALLOFF = 1.0 / 700.0; // haze thins with height; e-folding at 700 m
const float CITY_SPAN = 24000.0;       // the maps cover the 24 km tile grid, north up

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash31(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Analytic sky: used by the dome, by reflections and as the fog colour.
vec3 skyColor(vec3 d) {
  float h = max(d.y, 0.0);
  float k = mix(3.5, 9.0, uNight);
  vec3 c = mix(uSkyZenith, uSkyHorizon, exp(-h * k));
  float s = max(dot(d, uSunDir), 0.0);
  float low = exp(-h * 5.0);
  c += uSkyGlow * (0.55 * pow(s, 5.0) * low + 0.45 * pow(s, 48.0));
  return c;
}

// What a mirror sees: the sky above the horizon, sunlit ground and city below it.
vec3 envColor(vec3 d) {
  vec3 ground = vec3(0.36, 0.33, 0.29) * (uLightColor * max(uLightDir.y, 0.0) + uAmbSky) + vec3(0.050, 0.034, 0.018) * uNight;
  return mix(ground, skyColor(d), smoothstep(-0.25, 0.06, d.y));
}

vec3 hemi(vec3 n) {
  return mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);
}

vec2 cityUv(vec3 p) {
  return vec2(p.x, -p.z) / CITY_SPAN + 0.5;
}

float cityInside(vec2 uv) {
  return step(max(abs(uv.x - 0.5), abs(uv.y - 0.5)), 0.499);
}

// 1 in sunlight, 0 in the shadow of a building. Sample walls a little outside their own footprint.
float sunLit(vec3 p) {
  vec2 uv = cityUv(p);
  float s = texture2D(uShadowMap, uv).r;
  return mix(1.0, smoothstep(-0.5, 2.0, p.y - s), uShadowOn * cityInside(uv));
}

vec4 cityInfo(vec3 p) {
  vec2 uv = cityUv(p);
  return texture2D(uCityMap, uv) * cityInside(uv);
}

// Ambient occlusion from the height of the buildings around a point: streets between towers go dark.
float cityAO(vec3 p, vec4 info) {
  float occl = clamp((info.r * 510.0 - p.y) / 110.0, 0.0, 1.0);
  return 1.0 - 0.42 * occl;
}

vec3 shade(vec3 albedo, vec3 n, float lit, float ao) {
  return albedo * (uLightColor * (max(dot(n, uLightDir), 0.0) * lit) + hemi(n) * ao);
}

vec3 shadeLambert(vec3 albedo, vec3 n) {
  return shade(albedo, n, 1.0, 1.0);
}

// Exponential height fog, integrated along the view ray. Returns the fraction of light that survives.
float fogTransmittance(vec3 wp) {
  vec3 v = wp - cameraPosition;
  float len = length(v);
  float h0 = max(cameraPosition.y, 0.0);
  float h1 = max(wp.y, 0.0);
  float dh = h1 - h0;
  float e0 = exp(-FOG_FALLOFF * h0);
  float e1 = exp(-FOG_FALLOFF * h1);
  float avg = abs(dh) > 1.0 ? (e0 - e1) / (FOG_FALLOFF * dh) : e0;
  return exp(-uFogDensity * avg * len);
}

vec3 fogColor(vec3 wp) {
  vec2 hz = wp.xz - cameraPosition.xz;
  hz /= max(length(hz), 1e-3);
  return skyColor(normalize(vec3(hz.x, 0.04, hz.y)));
}

vec3 applyFog(vec3 col, vec3 wp) {
  return mix(fogColor(wp), col, fogTransmittance(wp));
}
`;

/** Last lines of every fragment shader: tone mapping and colour space, both no-ops when rendering into the post target. */
export const OUTPUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
