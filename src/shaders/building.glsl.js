// The one building shader, shared by every tile.
// Attributes: aNormal (xyz + kind/127), aUv (x in whole window bays along the wall, y in metres above ground),
// aColor (sRGB palette colour + seed/255).
import { COMMON, OUTPUT } from './common.glsl.js';

export const buildingVertex = /* glsl */ `
attribute vec4 aNormal;
attribute vec2 aUv;
attribute vec4 aColor;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
varying float vSeed;
varying float vKind;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = aNormal.xyz;
  vUv = aUv;
  vColor = aColor.rgb * aColor.rgb; // cheap sRGB decode
  vSeed = floor(aColor.a * 255.0 + 0.5);
  vKind = floor(aNormal.w * 127.0 + 0.5);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const buildingFragment = /* glsl */ `
${COMMON}
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
varying float vSeed;
varying float vKind;

float kindIs(float k) {
  return 1.0 - step(0.5, abs(vKind - k));
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 col;

  if (abs(n.y) > 0.5) {
    // Roofs and undersides.
    col = shadeLambert(vColor, n);
  } else {
    float glass = kindIs(1.0);
    float villa = kindIs(3.0);
    float civic = kindIs(6.0);
    float hasWin = 1.0 - max(kindIs(4.0), kindIs(7.0)); // sheds and canopies have none

    // Window rectangle inside one bay x one floor, per kind.
    vec2 lo = vec2(0.18, 0.30), hi = vec2(0.82, 0.80);
    lo = mix(lo, vec2(0.04, 0.10), glass);  hi = mix(hi, vec2(0.96, 0.92), glass);
    lo = mix(lo, vec2(0.30, 0.35), villa);  hi = mix(hi, vec2(0.70, 0.75), villa);
    lo = mix(lo, vec2(0.36, 0.22), civic);  hi = mix(hi, vec2(0.64, 0.86), civic);

    float floorH = mix(3.2, 3.9, glass);
    vec2 g = vec2(vUv.x, vUv.y / floorH);
    vec2 cell = floor(g);
    vec2 f = fract(g);
    vec2 fw = max(fwidth(g), vec2(1e-4));
    // 1 near the camera, 0 where a window is smaller than about a pixel: there we draw the average instead.
    float detail = 1.0 - smoothstep(0.25, 0.7, max(fw.x, fw.y));

    vec2 e = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f));
    float cover = (hi.x - lo.x) * (hi.y - lo.y);
    float aboveGround = mix(smoothstep(3.4, 4.2, vUv.y), 1.0, villa);
    float win = mix(cover, e.x * e.y, detail) * hasWin * aboveGround;

    float h1 = hash21(cell + vSeed * 7.13);
    float h2 = hash21(cell * 1.7 + vSeed * 3.71 + 11.0);
    float h3 = hash21(cell * 2.3 + vSeed * 1.9 + 5.0);
    float pane = mix(1.0, 0.8 + 0.4 * h2, detail);

    // Day: wall with a base darkening, glass that reflects the sky.
    float ao = mix(0.6, 1.0, smoothstep(0.0, 12.0, vUv.y));
    vec3 wallAlbedo = mix(vColor, vColor * 0.35, glass); // curtain-wall mullions are dark
    vec3 wall = shadeLambert(wallAlbedo * ao, n);
    vec3 R = reflect(-V, n);
    vec3 sky = skyColor(normalize(vec3(R.x, abs(R.y) * 0.7 + 0.05, R.z)));
    float fres = 0.05 + 0.95 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
    vec3 tint = mix(vec3(0.05, 0.065, 0.08), vColor * 0.55, glass);
    vec3 glassCol = shadeLambert(tint, n) * pane + sky * mix(0.22, 0.42, glass) * (0.4 + 0.6 * fres) * pane * mix(vec3(1.0), vColor * 2.2, glass * 0.5);
    glassCol += uLightColor * pow(max(dot(R, uLightDir), 0.0), 48.0) * mix(0.35, 0.9, glass) * pane;
    col = mix(wall, glassCol, win);

    // Night: lit windows. Each building has its own share of lit rooms, a few floors are fully lit.
    float chance = clamp(uLitFraction * (0.15 + 0.7 * hash11(vSeed * 1.31 + 3.0)), 0.0, 0.97);
    chance = mix(chance, max(chance, 0.85), step(0.95, hash11(cell.y * 13.7 + vSeed * 5.3)) * step(0.05, uLitFraction));
    float lit = mix(chance, step(h1, chance), detail);
    float coolShare = mix(0.15, 0.6, glass);
    vec3 warm = vec3(1.0, 0.72, 0.40), cool = vec3(0.76, 0.87, 1.0);
    vec3 lamp = mix(mix(warm, cool, coolShare), mix(warm, cool, step(h2, coolShare)), detail);
    // Most lit rooms are dim, a few are bright enough to bloom; the far average matches the near pattern.
    float bright = mix(0.42, 0.12 + 1.5 * h3 * h3 * h3 * h3, detail) * mix(1.0, 0.45, glass);
    float nightAmt = pow(uNight, 0.7);
    col += lamp * (lit * win * bright * nightAmt * 1.5);
    // Street lighting washes the first floors. The height is clamped: under MSAA a varying can be extrapolated
    // far below zero on a wall seen edge-on, and exp() of that overflows and floods the bloom pass.
    col += wallAlbedo * vec3(1.0, 0.6, 0.3) * (0.12 * uNight * exp(-max(vUv.y, 0.0) / 9.0));
  }

  col = applyFog(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
}
`;
