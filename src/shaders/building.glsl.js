// The one building shader, shared by every tile.
// Attributes: aNormal (xyz + kind/127), aUv (x: whole window bays along the wall, y: metres above ground,
// z: top of this volume in metres), aColor (sRGB palette colour + seed/255).
//
// What it draws, all from those few numbers: four facade types per building kind (punched windows, ribbon
// glazing, balconies, curtain wall / fins), a shopfront floor, a plant floor and parapet at the top, glass that
// mirrors the sky above and the city below with every pane tilted slightly, weathering, roof plant, sun shadows
// and occlusion from the city maps, and lit rooms at night.
import { COMMON, OUTPUT } from './common.glsl.js';

export const buildingVertex = /* glsl */ `
attribute vec4 aNormal;
attribute vec3 aUv;
attribute vec4 aColor;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vUv;
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
varying vec3 vUv;
varying vec3 vColor;
varying float vSeed;
varying float vKind;

float kindIs(float k) {
  return 1.0 - step(0.5, abs(vKind - k));
}

// Lit rooms on one floor come in runs of bays: a flat is one to three bays, an office floor plate three to ten.
// Returns the brightness of the run that bay cx of floor cy belongs to (0 when it is dark) and the run's lamp
// tone in [0, 1]. Most runs are dim and a few are bright, as in any photograph of a city at night. Where a run
// is narrower than a pixel (fwx bays) the floor's mean comes back instead.
float litRun(float cx, float cy, float glass, float chance, float fwx, out float tone) {
  float runLen = mix(1.0 + floor(hash11(cy * 7.1 + vSeed * 3.3) * 3.0), 3.0 + floor(hash11(cy * 5.3 + vSeed * 1.7) * 8.0), glass);
  float run = floor((cx + floor(hash11(cy * 3.7 + vSeed) * runLen)) / runLen);
  float hr = hash21(vec2(run, cy) + vSeed * 7.13);
  float ht = hash21(vec2(run, cy) * 1.9 + vSeed * 2.3);
  float inUse = mix(1.0, step(hash11(cy * 9.1 + vSeed * 2.9), 0.5) * 1.5, glass); // half the office floors are empty at night
  float p = min(chance * inUse, 1.0);
  float sharp = 1.0 - smoothstep(0.35, 1.0, fwx / runLen);
  tone = mix(0.5, ht, sharp);
  float hb = fract(ht * 17.3);
  return mix(p * 0.45, step(hr, p) * (0.18 + 0.82 * hb * hb), sharp);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  // Clamped: under MSAA a varying can be extrapolated far outside its range on an edge-on triangle.
  float y = max(vUv.y, 0.0);
  float top = max(vUv.z, y);
  float villa = kindIs(3.0);
  vec3 col;

  if (abs(n.y) > 0.5) {
    // ---- roofs and undersides ----
    vec4 info = cityInfo(vWorldPos);
    float lit = sunLight(vWorldPos, n);
    vec3 albedo = vColor;
    vec2 rw = fwidth(vWorldPos.xz);
    float near = 1.0 - smoothstep(0.3, 0.9, max(rw.x, rw.y) / 2.8);
    // Tiled villa roofs: ridges. Flat roofs stay plain; their plant is real geometry.
    albedo *= mix(1.0, 0.88 + 0.12 * sin(dot(vWorldPos.xz, vec2(0.8, 0.6)) * 2.4), villa * near);
    albedo *= 0.92 + 0.14 * vnoise(vWorldPos.xz * 0.11 + vSeed);
    col = shade(albedo, n, lit, cityAO(vWorldPos, info));
  } else {
    // ---- walls ----
    float glass = kindIs(1.0);
    float civic = kindIs(6.0);
    float hasWin = 1.0 - max(kindIs(4.0), kindIs(7.0)); // sheds and canopies have none
    float seedA = hash11(vSeed * 1.31 + 3.0);
    float style = floor(hash11(vSeed * 2.77 + 9.0) * 4.0);
    float s1 = 1.0 - step(0.5, abs(style - 1.0));
    float s2 = 1.0 - step(0.5, abs(style - 2.0));
    float s3 = 1.0 - step(0.5, abs(style - 3.0));
    float plain = (1.0 - glass) * (1.0 - villa) * (1.0 - civic);

    float floorH = mix(3.3, 3.9, glass);
    vec2 g = vec2(vUv.x * mix(1.0, 2.0, glass), y / floorH); // curtain walls have half-width bays: finer, less like tiles
    vec2 cell = floor(g);
    vec2 f = fract(g);
    vec2 fw = max(fwidth(g), vec2(1e-4));
    // 1 near the camera, 0 where a window is smaller than about a pixel: there we draw averages instead.
    float detail = 1.0 - smoothstep(0.25, 0.7, max(fw.x, fw.y));

    // Window rectangle inside one bay x one floor.
    vec2 lo = vec2(0.20, 0.28), hi = vec2(0.80, 0.78);                         // punched
    lo = mix(lo, vec2(-0.2, 0.34), plain * s1);  hi = mix(hi, vec2(1.2, 0.80), plain * s1);  // ribbon
    lo = mix(lo, vec2(0.10, 0.08), plain * s2);  hi = mix(hi, vec2(0.90, 0.72), plain * s2);  // balcony doors
    lo = mix(lo, vec2(0.12, 0.20), plain * s3);  hi = mix(hi, vec2(0.88, 0.84), plain * s3);  // large punched
    lo = mix(lo, vec2(0.02, 0.05), glass);       hi = mix(hi, vec2(0.98, 0.95), glass);       // curtain wall
    lo = mix(lo, vec2(0.12, 0.04), glass * s1);  hi = mix(hi, vec2(0.88, 0.96), glass * s1);  // fins
    lo = mix(lo, vec2(-0.2, 0.30), glass * s2);  hi = mix(hi, vec2(1.2, 0.92), glass * s2);   // glass ribbon
    lo = mix(lo, vec2(0.015, 0.03), glass * s3); hi = mix(hi, vec2(0.985, 0.97), glass * s3); // monolith
    lo = mix(lo, vec2(0.30, 0.35), villa);       hi = mix(hi, vec2(0.70, 0.75), villa);
    lo = mix(lo, vec2(0.36, 0.22), civic);       hi = mix(hi, vec2(0.64, 0.86), civic);

    vec2 e = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f));
    float cover = (min(hi.x, 1.0) - max(lo.x, 0.0)) * (hi.y - lo.y);

    // Zones up the wall: shopfront, typical floors, plant floor, parapet.
    float tower = step(70.0, top);
    float parapet = step(top - 1.1, y);
    float plant = tower * step(top - 1.1 - floorH * 1.6, y) * (1.0 - parapet) * (1.0 - glass); // glass towers are glazed to the top
    float ground = (1.0 - step(4.4, y)) * (1.0 - villa);
    float typical = (1.0 - ground) * (1.0 - parapet) * (1.0 - plant);
    float win = mix(cover, e.x * e.y, detail) * hasWin * typical;
    float posts = smoothstep(0.03, 0.03 + fw.x, f.x) * (1.0 - smoothstep(0.97 - fw.x, 0.97, f.x));
    float shop = ground * hasWin * smoothstep(0.5, 0.7, y) * (1.0 - smoothstep(3.7, 3.9, y)) * mix(0.9, posts, detail);
    win = max(win, shop);

    float h1 = hash21(cell + vSeed * 7.13);
    float h2 = hash21(cell * 1.7 + vSeed * 3.71 + 11.0);
    float h3 = hash21(cell * 2.3 + vSeed * 1.9 + 5.0);

    // Wall material: mullions on glass towers, weathered render or stone elsewhere.
    vec3 wallAlbedo = mix(vColor, vColor * 0.6, glass);
    wallAlbedo = mix(wallAlbedo, vColor * 0.85, glass * s2);             // spandrel panels between glass ribbons
    wallAlbedo *= 0.91 + 0.14 * vnoise(vec2(vUv.x * 0.21, y * 0.06) + vSeed);
    float joint = (1.0 - smoothstep(0.0, 0.05 + fw.y, f.y)) * detail * (1.0 - glass);
    wallAlbedo *= 1.0 - 0.16 * joint * typical;                          // floor joints
    float slab = smoothstep(0.84 - fw.y, 0.84 + fw.y, f.y) * plain * s2 * typical * detail;
    wallAlbedo = mix(wallAlbedo, vColor * 1.12, slab);                   // balcony slab edges catch the light
    float under = smoothstep(0.50, 0.84, f.y) * (1.0 - slab) * plain * s2 * typical * detail;
    float louvre = 0.74 + 0.16 * step(0.5, fract(y * 2.2));
    wallAlbedo *= mix(1.0, mix(0.82, louvre, detail), plant);
    wallAlbedo *= mix(1.0, 1.1, parapet);

    // Light: sample the city maps a little outside our own footprint.
    vec3 outside = vWorldPos + n * 9.0;
    float lit = sunLight(vWorldPos, n);
    vec4 info = cityInfo(outside);
    float ao = cityAO(vWorldPos, info) * mix(0.75, 1.0, smoothstep(0.0, 10.0, y));
    // Piers between bays: tilt the normal on either side of each bay line so the wall has relief in raking light.
    vec3 along = vec3(n.z, 0.0, -n.x); // the direction aUv.x grows in
    float pier = ((1.0 - smoothstep(0.0, 0.07, f.x)) - smoothstep(0.93, 1.0, f.x)) * detail * typical * (1.0 - glass * s3);
    vec3 wall = shade(wallAlbedo, normalize(n + along * (pier * 0.7)), lit, ao * (1.0 - 0.45 * under));

    // Glass: a mirror of the sky, its clouds and the city. Panes of a curtain wall are almost perfectly flat, so
    // a facade reflects as one smooth sheet; older punched windows wobble a little more.
    vec3 R = reflect(-V, n);
    R = normalize(R + (vec3(h1, h2, h3) - 0.5) * (mix(0.03, 0.004, glass) * detail));
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
    // Seen from the air a window would mirror the ground, which turns every facade the colour of sand. What reads
    // as glass is the sky in the direction the wall faces: bright toward a low sun, cool and dim away from it.
    vec3 Rs = normalize(vec3(R.x, abs(R.y) * 0.5 + 0.08, R.z));
    vec3 mirror = (glass > 0.5 ? envColor(Rs) : envPlain(Rs)) * mix(0.75, 1.0, ao) * mix(0.62, 1.0, smoothstep(0.0, 90.0, y)); // low floors mirror the street, not the sky
    vec3 tint = mix(vec3(1.0), vColor * 3.0, glass * 0.55);
    // A room behind every window (interior mapping): cast the view ray into a box one bay wide, one floor high
    // and five metres deep, and shade whichever surface it hits. Windows get depth and parallax for a few
    // lines of arithmetic, with no geometry.
    // Skipped where no window is resolved: most of the screen is far walls.
    float room = 0.55, curtain = 0.0;
    if (detail > 0.001 && win > 0.001) {
      vec3 rd = vec3(-dot(V, along), -V.y, max(dot(V, n), 0.02)); // z runs into the building
      vec3 size = vec3(3.1 * mix(1.0, 0.5, glass), floorH, 5.0);
      vec3 ro = vec3(f.x, f.y, 0.0) * size;
      vec3 reach = (step(0.0, rd) * size - ro) / (rd + sign(rd) * 1e-4 + 1e-5);
      float th = min(reach.x, min(reach.y, reach.z));
      vec3 hit = ro + rd * th;
      float isBack = step(reach.z, min(reach.x, reach.y));
      float isLevel = (1.0 - isBack) * step(reach.y, reach.x);
      float surface = mix(0.62, 0.8, isBack);                    // side walls, back wall
      surface = mix(surface, mix(0.38, 1.0, step(0.0, rd.y)), isLevel); // floor, ceiling
      vec2 bw = hit.xy / size.xy;
      surface *= 1.0 - 0.35 * isBack * step(hash21(cell * 3.3 + floor(bw * vec2(3.0, 2.0)) + vSeed), 0.35) * step(bw.y, 0.55); // furniture, doors
      curtain = step(0.7, hash21(cell * 4.1 + vSeed * 2.3)) * detail * (1.0 - glass); // some have blinds drawn
      room = mix(mix(0.55, surface / (1.0 + th * 0.22), detail), 0.7, curtain);
    }
    vec3 roomTint = mix(vec3(0.72, 0.68, 0.60), vec3(0.58, 0.62, 0.68), h2);
    vec3 interior = roomTint * room * mix(0.16, 0.34, curtain);
    interior = mix(interior, interior * 0.2 + vColor * 0.2, glass); // tinted glass has a body colour of its own and hides the rooms by day
    float reflectance = mix(0.5, 0.9, glass) * (0.5 + 0.5 * fres);
    vec3 glassCol = shade(interior, n, lit, ao) * (1.0 - 0.4 * under) + mirror * tint * reflectance;
    glassCol += uLightColor * (pow(max(dot(R, uLightDir), 0.0), 64.0) * lit * mix(0.5, 1.3, glass));
    // Reveal: the glass sits back from the wall face, so the head of a punched window is in shade.
    glassCol *= 1.0 - 0.5 * smoothstep(0.78, 0.97, (f.y - lo.y) / max(hi.y - lo.y, 0.01)) * plain * detail * typical;
    col = mix(wall, glassCol, win);

    // Night. A lit facade is not a random checkerboard: light comes in runs. A flat spans a few bays and an
    // office floor is in use or dark as a whole; inside a run the bays differ a little and some have blinds
    // down. Colour runs from warm lamp light to neutral white, cooler in offices. At mid distance the runs
    // become blocks, far away a dim average, so distant buildings stay dark shapes with lights on them.
    //
    // From the air the pattern must not change, only blur: the same runs are drawn at every distance. Where a
    // bay is smaller than a pixel a run is one dash, a floor high. Where a floor is smaller than a pixel the
    // dash is blended with the floor next to it, and beyond that the wall takes the mean of its runs. (Blocks of
    // 6 bays by 2 floors stood here before: a second, coarser pattern that read as tiles.)
    float chance = clamp(uLitFraction * (0.2 + 0.6 * seedA), 0.0, 0.9);
    float hcA, hcB;
    float runA = litRun(cell.x, cell.y, glass, chance, fw.x, hcA);
    float litNear = runA * step(0.25, h1) * (0.5 + 0.7 * h3);
    float side = f.y > 0.5 ? 1.0 : -1.0;
    float runB = litRun(cell.x, cell.y + side, glass, chance, fw.x, hcB);
    float spill = clamp((abs(f.y - 0.5) + 0.5 * fw.y - 0.5) / fw.y, 0.0, 0.5); // share of this pixel on the next floor
    float floors = 1.0 - smoothstep(0.9, 2.4, fw.y);
    float mean = chance * mix(1.0, 0.75, glass) * 0.45;
    float litMid = mix(mean, mix(runA, runB, spill), floors) * 0.64; // 0.64: the mean of the bays inside a run
    float litRooms = mix(litMid, litNear, detail);
    float hc = mix(0.5, mix(hcA, hcB, spill), floors);
    vec3 home = mix(vec3(1.0, 0.56, 0.24), vec3(1.0, 0.80, 0.54), hc);
    vec3 office = mix(vec3(1.0, 0.80, 0.54), vec3(0.84, 0.92, 1.0), smoothstep(0.72, 0.95, hc));
    vec3 lamp = mix(home, office, glass);
    float nightAmt = pow(uNight, 0.7);
    // Kept below the level where the tone curve bleaches colour: lamp light should stay amber, not go white.
    col += lamp * (min(litRooms * mix(1.0, room * 1.9, detail), 1.0) * win * typical * nightAmt * mix(1.15, 0.95, glass));
    float shopLit = step(0.3, hash11(cell.x * 3.1 + vSeed)) * shop;
    col += vec3(1.0, 0.74, 0.46) * (shopLit * nightAmt * 0.9);
    // The city lights its own walls: a strong sodium wash on the first floors and a faint one far up, so towers
    // read as shapes and not as holes in the sky.
    col += wallAlbedo * vec3(1.0, 0.62, 0.34) * (uNight * (0.22 * exp(-y / 10.0) + 0.09 * exp(-y / 110.0)) * (0.35 + 0.65 * info.a));
    // Crown and setback lighting: a band of light at the top of each tier of a tall tower, in white, amber or blue.
    float accent = step(110.0, top) * step(0.62, hash11(vSeed * 4.7 + 1.0)) * step(top - 1.5, y) * (1.0 - step(top - 0.3, y));
    float pick = hash11(vSeed * 9.3 + 2.0);
    vec3 accentCol = mix(vec3(0.90, 0.95, 1.0), vec3(1.0, 0.70, 0.36), step(0.4, pick));
    accentCol = mix(accentCol, vec3(0.30, 0.55, 1.0), step(0.75, pick));
    col += accentCol * (accent * uNight * 0.9);
  }

  col = applyFog(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
}
`;
