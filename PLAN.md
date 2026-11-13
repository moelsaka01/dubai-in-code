# Dubai in Code — PLAN

A browser 3D model of Dubai built only from OpenStreetMap data and code. No 3D software, no downloaded models, no AI asset generators.
**A fresh chat should read this file and nothing else before starting a phase.** Then open only the files its task names.

Rules for every phase: plan before coding, no screenshots unless asked (Phase 4A asks for them, see §5), no trial-and-error loops, update `BUILD_LOG.md` and tick the boxes in §5 before the final commit.

---

## 0. Decisions already made

| Topic | Decision | Why |
|---|---|---|
| Stack | Vite + vanilla Three.js (WebGLRenderer), plain JS ES modules | The scene is merged geometry, custom shaders and workers. React Three Fiber adds a reconciler and nothing we need. |
| Units | 1 unit = 1 m. Data stores (east, north). Scene is `x = east, y = up, z = -north` | Flipping north to −z reverses winding: handle once, in the tile worker. |
| Projection | Local equirectangular around `ORIGIN` (25.145, 55.1975): 100 831 m/° lon, 110 775 m/° lat | Error under 2 m across a 20 km scene. Lives in `src/shared/config.js`, used by pipeline and app. |
| Data source | Overpass API, raw JSON cached in `data/raw/` (gitignored) | Area is small; a Geofabrik extract would need osmium and 200 MB+. |
| Palm scope | Whole Palm (land and buildings), not just trunk + first fronds | The whole Palm bbox holds only ~2 700 buildings, and half a palm reads as a bug. |
| Triangulation | In the browser, in a Web Worker (`earcut`) | Shipping footprints is ~3× smaller than shipping triangles. |
| Shadows | Sun shadows and ambient occlusion from a top-down height map of the city (`src/world/cityMap.js`), one texture fetch per fragment. No per-frame shadow pass | A 20 km scene cannot afford cascades at 60 fps on a laptop. Changed in the Phase 3 review: without shadows the city read as toy blocks. |

Measured on 2026-11-12 (Overpass `out count`, world bbox): **100 281** building ways, 413 building relations, 1 097 `building:part` ways, **2 219 with `height` (2.2%)**, **7 636 with `building:levels` (7.6%)**, 6 375 major road ways, 9 150 minor road ways, 245 coastline ways, 197 water ways + 18 water relations.
So about 90% of heights are estimated. That is the main quality risk (§6).

---

## 1. Bounding boxes and queries

All boxes are `(south, west, north, east)`, the order Overpass expects. Source of truth: `src/shared/config.js`.

| Key | Bbox | Buildings | Contents |
|---|---|---|---|
| `world` | 25.055, 55.095, 25.235, 55.300 | 100 281 | Everything. ~20.7 km E–W × 19.9 km N–S |
| `marina` | 25.060, 55.110, 25.100, 55.160 | 2 638 | Dubai Marina, JBR, Bluewaters (Ain Dubai), JLT backdrop |
| `palm` | 25.095, 55.100, 25.147, 55.165 | 2 709 | Whole Palm Jumeirah incl. crescent |
| `downtown` | 25.178, 55.250, 25.228, 55.295 | 11 511 | Burj Khalifa, Dubai Mall, fountain lake, Business Bay, DIFC, Museum of the Future |
| `baa` | 25.128, 55.178, 25.148, 55.200 | 1 831 | Burj Al Arab island, Jumeirah Beach Hotel, Madinat Jumeirah |
| `szr` | 600 m buffer around the Sheikh Zayed Road centreline | computed | Built in the pipeline from ways with `ref=E 11` |
| `land` | 24.935, 54.975, 25.355, 55.420 | – | `world` padded 0.12°, coastline only, so the ground runs to the haze |

**Tiers.** Tier A (focus) = `marina ∪ palm ∪ downtown ∪ baa ∪ szr`: every building, 0.5 m simplification. Tier B (context) = rest of `world`: footprint ≥ 120 m², 2 m simplification, no `building:part`.

Landmark anchors (from OSM, 2026-11-12):

| Landmark | lat, lon | OSM | Real height | Clear radius |
|---|---|---|---|---|
| Burj Khalifa | 25.19704, 55.27421 | way 446646206 | 828 m | 95 m |
| Cayan Tower | 25.08685, 55.14517 | way 195527255 | 306 m | 35 m |
| Museum of the Future | 25.21896, 55.28206 | way 33875310 | 77 m | 60 m |
| Ain Dubai | 25.08005, 55.12379 | way 1047288986 | 250 m | 130 m |
| Burj Al Arab | 25.1412, 55.18556 | way 12700546 (verified in P2; its `name` tag is Arabic, `name:en` = "Jumeirah Burj Al Arab") | 321 m | 70 m |

OSM buildings and parts whose centroid falls inside a clear radius are dropped; the procedural landmark replaces them.

### Overpass queries

Endpoint `https://overpass-api.de/api/interpreter`, POST body `data=<query>`. **Send a descriptive `User-Agent`** (a bare `curl/8` got HTTP 406 today). Wait 10 s between requests; on 429/502/504 back off 15 → 30 → 60 → 120 s. Skip a request if its raw file is already cached.

```
# Q1 buildings: run once per cell of a 3×3 grid over `world`, dedupe by type+id
[out:json][timeout:180][maxsize:536870912];
( way["building"]({{cell}});
  way["building:part"]({{cell}});
  relation["building"]["type"="multipolygon"]({{cell}});
  relation["building:part"]["type"="multipolygon"]({{cell}}); );
out tags geom qt;

# Q2 roads and rail: `world`, one request
[out:json][timeout:180];
( way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)(_link)?$"]({{world}});
  way["railway"~"^(subway|light_rail|monorail|tram)$"]({{world}}); );
out tags geom qt;

# Q3 coastline: padded `land` bbox
[out:json][timeout:120];
way["natural"="coastline"]({{land}});
out geom qt;

# Q4 inland water: `world`
[out:json][timeout:120];
( way["natural"="water"]({{world}}); relation["natural"="water"]({{world}}); );
out tags geom qt;

# Q5 ground cover (optional layer): `world`
[out:json][timeout:120];
( way["leisure"~"^(park|golf_course|pitch)$"]({{world}});
  way["landuse"~"^(grass|recreation_ground)$"]({{world}});
  way["natural"="beach"]({{world}}); );
out tags geom qt;

# Q6 landmark lookup: `world`
[out:json][timeout:60];
nwr["name"~"Burj Khalifa|Burj Al Arab|Cayan Tower|Museum of the Future|Ain Dubai"]({{world}});
out center tags;
```

---

## 2. Data format and pipeline

```
scripts/fetch-osm.mjs  →  data/raw/*.json           (gitignored, ~80–120 MB)
scripts/build-data.mjs →  public/data/              (committed, budget below)
   project → clean → parts → heights → simplify → classify → tile → encode
```

1. **Project** lat/lon to local metres (east, north).
2. **Clean**: close rings, drop footprints < 12 m² and degenerate rings, enforce outer CCW / holes CW. Multipolygon relations become outer + inner rings.
3. **Parts**: if `building:part` polygons whose centroids lie inside an outline cover ≥ 50% of its area, drop the outline and keep the parts with `min_height`. Else drop the parts. Tier A only.
4. **Heights**, first match wins. Record the source per building.
   1. `height` tag (parse `"123"`, `"123 m"`, feet).
   2. `building:levels` × 3.2 m (+ `roof:levels`).
   3. `data/overrides.json`: known towers by name or OSM id.
   4. Estimate from zone + footprint area + `building=*`, varied by a hash of the OSM id so runs are reproducible:

   | Zone | Area 300–3 000 m² | Larger | Smaller |
   |---|---|---|---|
   | `marina` | tower 90–260 m, skewed low | podium 12–25 m | 6–10 m |
   | `downtown` | tower 60–220 m, skewed low | mall/podium 15–30 m | 8–15 m |
   | `szr` outside those | 20–60 m | 12–20 m | 8–12 m |
   | `palm` trunk (within 350 m of the axis) | 30–50 m | 20–30 m | 9 m |
   | `palm` fronds / crescent | 9 m villas; crescent > 1 500 m² → 25–60 m | – | 7–9 m |
   | `baa` | 12–30 m | 15–25 m | 7–9 m |
   | context | 7–12 m; `apartments` 15–30 m | 9–14 m | 7 m |

   `building=house|villa|detached|garage|roof|shed|hut` always takes the low rule.
5. **Simplify** with Douglas–Peucker (0.5 m Tier A, 2 m Tier B, 1 m roads, 1 m coast inside `world`, 8 m outside).
6. **Classify** `kind` (0 generic, 1 glass tower [h ≥ 60], 2 residential, 3 villa, 4 industrial, 5 retail, 6 civic/mosque, 7 roof/canopy) and a `seed` byte.
7. **Land**: stitch coastline ways by shared end nodes. Closed chains are islands. Open chains are clipped to `land` bbox and closed along its edge **counter-clockwise** (OSM keeps land on the left of a coastline). Then `land = union(land) − union(inland water)`, so the Marina canals, the Dubai Water Canal and the Burj lake show the sea plane through real cut-outs.
8. **Tile**: 2 000 m grid, 12 × 12, `GRID_MIN = −12 000` on both axes. A feature goes to the tile holding its centroid (roads: first vertex). No clipping. Ways over ~2 km are split.
9. **Encode**, then write `manifest.json` and a stats report.

### Files in `public/data/`

| File | Content |
|---|---|
| `manifest.json` | version, origin, tile size, grid, per-tile `{id, bytes, nBuildings, nRoads, maxHeight}`, height-source stats, OSM data timestamp |
| `tiles/{tx}_{ty}.bin` | buildings + roads of one tile |
| `land.bin` | land polygons, plus green and beach polygons |
| `traffic.json` | SZR stitched into two long polylines (one per direction), plus other motorways, for car lights |
| `landmarks.json` | per landmark: lat/lon, local x/north, footprint rotation (min-area rectangle angle), dropped OSM ids |

### Tile binary (little-endian, read with `DataView`; codec in `src/shared/format.js`, imported by both sides)

```
Header 16 B : "DXB1" | u16 version | u8 tx | u8 ty | u32 nBuildings | u16 nTall | u16 nRoads
Building    : u16 height_dm | u16 minHeight_dm | u8 flags | u8 seed | u8 nRings
              then per ring: u8 nPts | nPts × (i16 x_dm, i16 y_dm)
   flags    : bits 0–1 heightSrc (0 tag, 1 levels, 2 override, 3 estimate) | bits 2–4 kind | bit 5 tierB | bit 6 isPart
   order    : sorted by height, tallest first. The first nTall have height ≥ 40 m (this gives LOD for free, §3)
Road        : u8 class | u8 lanes | u8 flags (1 bridge, 2 tunnel, 4 oneway) | i8 layer | u16 nPts | nPts × (i16 x_dm, i16 y_dm)
   class    : 0 motorway 1 trunk 2 primary 3 secondary 4 tertiary 5 minor 6 link 7 rail
```

Coordinates are decimetres relative to the tile's south-west corner (range ±3 276 m, so features may overhang the tile).
`land.bin`: `"DXL1" | u16 version | u16 nPolys`, then per polygon `u8 kind (0 land, 1 green, 2 beach) | u8 nRings`, per ring `u32 nPts | nPts × (i32 x_dm, i32 y_dm)` in global coordinates.

### Size budget (committed data)

| Layer | Estimate | Raw |
|---|---|---|
| Tier A buildings | ~25 k × ~45 B | 1.1 MB |
| Tier B buildings | ~60 k × ~30 B | 1.8 MB |
| Roads and rail | ~16 k ways × ~55 B | 0.9 MB |
| Land, traffic, landmarks, manifest | | 0.4 MB |
| **Total** | **target ≤ 4.5 MB raw, ≤ 2.5 MB gzipped. Hard cap 8 MB raw, 400 KB per tile** | |

If over budget: raise the Tier B area threshold (120 → 200 → 300 m²), then the Tier B tolerance (2 → 3 m), then drop class-5 roads outside Tier A.

---

## 3. Rendering architecture

**Loading.** `manifest.json` → `land.bin` → tiles, ordered by distance to the tour's first camera position. One module worker (`src/data/tileWorker.js`) decodes a tile, triangulates roofs, builds walls and road ribbons, and transfers typed arrays back. The main thread only creates `BufferGeometry` objects.

**Tiles.** Each tile is two meshes: buildings and roads. That is ≤ ~70 land tiles × 2 draw calls, frustum-culled with bounding spheres from real geometry.

**LOD.** The building index buffer follows the tallest-first order, so a far tile (> 7 km) calls `geometry.setDrawRange(0, tallIndexCount)` and draws only its ≥ 40 m buildings with no extra memory. Roads of class ≥ 4 hide beyond 5 km.

**Building mesh.** Walls and roofs only, no floors. Vertex attributes: position, normal, `aUv` (metres along the wall, metres up), `aColor` (palette by kind + seed), `aSeed`. About 22 triangles per building, ~1.5–2 M triangles in the whole city and under 1.2 M in view.

**One building shader** (`ShaderMaterial`, shared by every tile):
- Day: sun diffuse + hemisphere ambient + fresnel sky tint on glass kinds + base AO gradient (`aUv.y < 12 m`).
- Windows: a procedural grid from `aUv` (3.2 m floors, ~3 m bays). Per-window hash against `uLitFraction`. Warm/cool variation, some floors fully lit, dark roofs.
- Night: window emissive × `uNight`. Fades to an averaged glow with distance, which stops aliasing shimmer.
- Shared GLSL chunk `src/shaders/common.glsl.js` for sun, ambient, height fog and tone curve. Landmarks, roads and land use it too, so the whole scene shifts together.

**Instancing.** Car lights (one `InstancedMesh` of billboards, ~1 500 instances, positions from the arc-length tables in `traffic.json`; white facing the camera, red going away). Street lights along class 0–2 roads (one `Points`). Red aviation beacons on buildings > 150 m (one `Points`). Ain Dubai capsules.

**Roads.** Ribbons triangulated in the worker, width from class/lanes (SZR ≈ 2 × 22 m), at y = 1.6 m with `polygonOffset`. At night: dark asphalt with sodium-orange emissive centre lines on class 0–2. Bridges are flat in v1; where they cross the canal cut-outs they already read as bridges.

**Ground and sea.** Land is extruded 1.5 m with a vertical quay skirt, sand coloured with slight noise, plus green and beach patches at +0.05 m. The sea is one 80 km plane at y = 0.

**Water shader** (`src/world/water.js`): analytic normals from 4 scrolling sine sets plus one fbm octave, fresnel mix of deep colour and the analytic sky colour, sun or moon glint, distance fade to the horizon colour. Phase 4 adds a shore mask: render the land once top-down into a 2048² texture and blur it, which gives turquoise shallows, foam, and at night the city's glow on the water.

**Sky and time of day** (`src/env/timeOfDay.js`). One parameter `t ∈ [0,1]`, keyframed and interpolated into a single `env` object that every material reads:

| t | Moment | Sun | Look |
|---|---|---|---|
| 0.00 | Noon | elevation 70° | pale blue sky, light haze, hard white light |
| 0.50 | Golden hour | elevation 8°, azimuth ~285° (over the Gulf) | orange horizon, long warm light, 20% of windows lit |
| 0.75 | Blue hour | −6° | deep blue sky, 60% lit, bloom on |
| 1.00 | Night | −30°, dim moon fill | near-black sky with stars, warm horizon glow band, 70% lit, cars and street lights at full |

Sky dome shader: zenith/horizon gradient, sun disc and glow, stars, city-glow band. Renderer: ACES tone mapping, exposure from `env`. Post: own bloom chain at half resolution plus FXAA in one final pass (`src/post.js`, see the review notes in §5), strength from `env.bloom`. Fog is exponential height fog in the shared chunk (Dubai haze is authentic and hides the world edge).

**Camera.** `src/camera/tour.js`: Catmull-Rom splines through position and look-at keyframes, ~40 s, eased. The tour also drives `t` from golden hour to night, so it lands on the night skyline. Route: offshore of Bluewaters (Ain Dubai + JBR) → along the Marina canal past Cayan Tower → climb over the Palm trunk toward Atlantis → down the coast past Burj Al Arab → along Sheikh Zayed Road → rising orbit of Burj Khalifa from the fountain lake. Any input skips it. `src/camera/controls.js`: `OrbitControls` with damping, a ground clamp, and WASD/arrow keys to fly the target.

**UI** (`src/ui/`): plain HTML/CSS overlay with title, time slider, Tour button, quality toggle (Low / High), landmark jump chips, loading bar, and an always-visible "© OpenStreetMap contributors" link to `openstreetmap.org/copyright`.

**Frame budget (mid-range laptop, 1080p):** ≤ 250 draw calls, ≤ 1.2 M triangles in view, device pixel ratio capped at 1.5, bloom half-res, `near = 5`, `far = 60 000`. If the frame time stays above 20 ms for 2 s, drop to Low automatically (DPR 1, no bloom, tighter LOD).

---

## 4. Landmarks (pure code, `src/landmarks/*.js`)

Each module exports `create(env) → { group, update(dt, env) }`, is built around its own origin with base at y = 0, and is placed and rotated from `landmarks.json`. Budget: ≤ 15 k triangles and ≤ 4 draw calls each. Silhouette first.

| Landmark | Approach |
|---|---|
| **Burj Khalifa** (828 m) | Y-plan: hexagonal core + 3 wings at 120°, each a rounded-nose shape ~72 m long and ~24 m wide at the base. 27 setbacks in a spiral: setback *k* shortens wing `k mod 3` at height `h_k` (spaced so the tiers thin toward the top, last wing tier at ~600 m). For each height band, build the 2D union outline of core + current wings and extrude it: ~27 stacked prisms. Above that, a 3-step telescoping spire to 828 m. Shader: silver-blue glass with fine vertical fins. Night: cool white facade shimmer, spire beacon. |
| **Burj Al Arab** (321 m) | Loft: 40 height slices × 24 section points. The section is a V-shaped wedge (two wings from a mast). Its depth follows a sail curve: a Bézier from the base, bulging at about one third of the height, tapering to the mast top. Add the mast (thin cylinder to 321 m), two curved exoskeleton tubes following the bow, the helipad disc at 210 m on a short cantilever, and a white fabric face between the wings. The island and bridge come from OSM land. Night: slow colour-cycling emissive on the fabric face. |
| **Cayan Tower** (306 m) | Loft of 75 rings, each the chamfered-rectangle footprint (~36 × 30 m, or the OSM outline) rotated by 1.2° more than the one below: 90° total. Shared vertices between rings give the smooth helix. The shader draws floor bands and the corner columns as helical lines from UVs. |
| **Museum of the Future** (77 m) | Parametric surface: an elliptical ring standing upright (centre curve ~28 m × 30 m semi-axes) swept with a varying elliptical cross-section, thicker at the base, with the oval void slightly off-centre. Sits on a squashed green mound ~15 m high. Shader: brushed steel with strong fresnel sky reflection, and flowing calligraphy-like strokes from domain-warped bands that glow white at night. |
| **Ain Dubai** (250 m) | Rim `TorusGeometry` (radius ~118 m), 48 instanced capsules, spokes as `LineSegments` from hub to rim, hub cylinder at ~126 m, four tapered legs in two A-frames. Slow rotation in `update`. Night: animated LED pattern on the rim. |

Stretch, Phase 4 only if budget allows: Dubai Fountain jets (instanced particles on the Burj lake at night), Atlantis arch, Metro viaduct from the rail ways.

---

## 5. Phases and tasks

Tick boxes as they land. Each task is one commit.

### Phase 1 — plan and skeleton (Fable 5.2) ✅
- [x] `PLAN.md`, Vite + Three.js skeleton, `src/shared/config.js`, `README.md`, `BUILD_LOG.md`, first commit

### Phase 2 — data pipeline (Sonnet 5.5) ✅
Done when `npm run data:fetch && npm run data:build` produces `public/data/` inside the budget and `npm run data:stats` prints the report.
- [x] 2.1 `scripts/fetch-osm.mjs`: Q1–Q6, 3×3 grid for Q1, cache, User-Agent, backoff, `--force` flag. Touches: `scripts/fetch-osm.mjs`, `scripts/lib/overpass.mjs`
- [x] 2.2 Resolve Burj Al Arab from Q6; write its coordinates into `src/shared/config.js`
- [x] 2.3 `src/shared/format.js`: encode + decode for tiles and `land.bin`, with a round-trip self-test (`node src/shared/format.js --test`)
- [x] 2.4 Geometry helpers: ring area/centroid/orientation, Douglas–Peucker, point-in-polygon, min-area rectangle. Touches: `scripts/lib/geom.mjs`
- [x] 2.5 Buildings: load + dedupe, multipolygons, clean, tier assignment, landmark clearing. Touches: `scripts/lib/buildings.mjs`
- [x] 2.6 `building:part` resolution (step 3 of §2). Touches: `scripts/lib/parts.mjs`
- [x] 2.7 Heights: tag parsing, levels, overrides, zone estimator. Touches: `scripts/lib/heights.mjs`, `data/overrides.json` (seed with ~30 known towers)
- [x] 2.8 Roads + rail: classify, simplify, split long ways; SZR stitching into `traffic.json`. Touches: `scripts/lib/roads.mjs`
- [x] 2.9 Coast: stitch, close, union, subtract water; green/beach polygons. Add `polygon-clipping` (fallback `polyclip-ts`). Touches: `scripts/lib/coast.mjs`
- [x] 2.10 Tiling + encode + manifest + `landmarks.json`. Touches: `scripts/build-data.mjs`
- [x] 2.11 `scripts/stats.mjs`: sizes vs budget, height-source %, the 30 tallest buildings with source, count of estimated ≥ 150 m, land polygon count and area
- [x] 2.12 `public/data/` built (no git repo exists yet, so nothing was committed), `BUILD_LOG.md` updated

### Phase 3 — rendering and landmarks (Fable 5.2) ✅
**Accepted by the owner as version 0.1.0 on 2026-11-13** ("I will allow it for a 0.1.0 version"), after four rounds of review: the review pass, the detail pass, the lighting pass and the evening and night pass, all recorded below. What the owner still sees as weak is the task list of Phase 4.
Done when the city loads, the slider works from noon to night, the five landmarks stand in place and the tour plays.
- [x] 3.1 App shell: renderer, resize, render loop, quality state. Touches: `src/main.js`, `src/app.js`
- [x] 3.2 `timeOfDay.js` + sky dome + shared GLSL chunk. Touches: `src/env/timeOfDay.js`, `src/world/sky.js`, `src/shaders/common.glsl.js`
- [x] 3.3 Loader + tile worker (decode, earcut roofs, walls, ribbons). Touches: `src/data/loader.js`, `src/data/tileWorker.js`
- [x] 3.4 Land + sea plane + water shader v1. Touches: `src/world/land.js`, `src/world/water.js`
- [x] 3.5 Buildings: tile meshes, building shader with windows, LOD draw range. Touches: `src/world/buildings.js`, `src/shaders/building.glsl.js`
- [x] 3.6 Roads + street lights + car lights. Touches: `src/world/roads.js`, `src/world/traffic.js`
- [x] 3.7 Landmarks, one commit each, in this order: Burj Khalifa, Ain Dubai, Cayan, Burj Al Arab, Museum of the Future. Touches: `src/landmarks/*.js`
- [x] 3.8 Controls + tour + UI overlay with attribution. Touches: `src/camera/*.js`, `src/ui/ui.js`, `src/style.css`, `index.html`
- [x] 3.9 Bloom + tone mapping pass. Touches: `src/post.js`
- [x] 3.10 `npm run build` passes; update `BUILD_LOG.md`

What Phase 3 built differently from §3 and §4 (read before Phase 4):
- **Not looked at yet.** No screenshots were taken (rule above). Everything was checked by numbers: shader compile, mesh orientation and volume, pixel samples per time of day, UI events. Colours, bloom and landmark proportions still need a human look; that is the first job of Phase 4.
- Extra files: `src/world/lightPoints.js` (street lights and beacons), `src/landmarks/common.js` (geometry builder + landmark material), `src/landmarks/index.js` (placement and chip views).
- Draw order replaces small y gaps: sky, then sea (no depth write), then land, cover, roads (`renderOrder` + `polygonOffset`), then everything else. The quay wall ends at y = 0.
- Burj Khalifa and Burj Al Arab are placed from the raw OSM outline, not from `landmarks.json` (its min-area rectangle does not give the wing or sail direction). Constants are in `src/landmarks/index.js`.
- Bloom strength is 0.12 (golden hour) to 0.4 (night), threshold 1.0. UnrealBloomPass sums its mips with weights near 3, so the 0.7–0.85 first tried washed out the frame. With bloom off (noon, or Low) the scene renders straight to the canvas.
- Tour runs 54 s, not ~40 s: at 40 s the Palm to Downtown legs pass 1 300 m/s. Its path was checked against every building >= 60 m (25 m margin).
- Wall window `u` is in whole bays per wall, not metres, so windows never straddle a corner.
- Varyings can be extrapolated far outside their range on edge-on triangles under MSAA. Never feed one to `exp()` or `pow()` unclamped (this flooded the bloom pass once).
- `window.__dubai` exposes `stats()` (draw calls, triangles), `frame(now)` and `env.setTime(t)` for checks and for the Phase 4 `?perf` overlay.

**Phase 3 review pass (after the first look, 2026-11-12).** The owner's verdict on the first version: the tour lagged and the city looked like Lego, the Museum of the Future worst of all. What changed, and what a later phase must not undo:
- **Frame time.** At 1920x1080 on Intel Iris Xe the tour now takes 8.6 to 11.3 ms a frame (before: about 21 to 27 ms). `EffectComposer` + `UnrealBloomPass` are gone. `src/post.js` renders the scene into a float target without MSAA, blurs a half-size bright pass with five dual-filter levels, and one final pass does FXAA + bloom + tone mapping. 4x MSAA on a float target alone cost 6 to 7 ms. Sea and sky are drawn last, so pixels behind land and buildings are never shaded.
- **Resolution governor** (`govern()` in `src/app.js`). When frames average over 20.5 ms the render scale drops by 18%, down to 0.5. Each drop is a trial: if the frame time does not improve it is undone and locked out, because a throttled tab or a 30 fps cap is not a fill-rate problem. This is the auto quality fallback of task 4.2 in a different form.
- **Shadows and occlusion** (`src/world/cityMap.js`). After loading, the city is rendered straight down into a 2048^2 height map (11.7 m per texel). From it: a static city map (occlusion height, shore blur, built-up density) and a shadow map that stores, per texel, the height below which a point is in shadow. The shadow map is recomputed in 24 strips over 24 frames when the sun moves more than 0.35 degrees (18 ms for a full update). Every material reads both through `sunLit()`, `cityInfo()` and `cityAO()` in the shared chunk. Walls sample 9 m outside their own footprint.
- **Buildings.** `src/data/buildingMesh.js` (split from the worker) adds crowns to compact towers of 55 m or more: plant boxes, stepped tops, masts, picked by seed. Floating `building:part` volumes with nothing under them are stood on the ground. The uv attribute is now three floats (bays, height, top of the volume). The shader has four facade types per kind, a shopfront floor, plant floor and parapet, roof plant, weathering, and glass that mirrors sky above and ground below (`envColor()`), each pane tilted slightly. Palette is muted.
- **Night.** Lit rooms are drawn per window up close, in blocks of 3x3 at mid distance and as a dim average far away. A plain average turned every distant building into a grey box.
- **Ground, roads, water.** Sand turns to paving where the density map says the city is built up. Asphalt is mid grey with a pale kerb. Water normals come from three noise octaves that fade out when smaller than a few pixels (the sine waves showed moire rings); the shore channel gives turquoise shallows and surf. This is task 4.3.
- **Museum of the Future.** Rebuilt: slimmer at the top, deeper at the base, leaning, brushed steel with real reflections, and eight rows of script built from strokes chosen per letter by a hash.
- Also fixed: the Cayan chip view (was blocked by a tower), Ain Dubai's spokes at night, the chips overlapping the status line under 720 px, car lights visible as blobs by day.
- Known limits: shadows are soft and coarse (11.7 m texels) and widen with distance; low villas cast almost none. Daylight Burj Khalifa is plain at a distance. The screenshot tool of the preview pane crops at 150% display scaling; shrink the canvas to 66.667% in the page to see whole frames.

**Detail pass (2026-11-13).** Second verdict from the owner: smooth now, but still Lego. The cause was that everything was still an extruded footprint on bare ground. Added, all generated from the OSM data already shipped (no new data, no assets):
- **Massing** (`src/data/buildingMesh.js`). Towers of 45 m or more on a compact footprint over 900 m² get a podium with a slimmer shaft set to one side (a quarter stay plain). Villas get a pitched roof: one flat-shaded triangle per wall meeting above the centre, only where every wall can see the centre. Flat roofs in the focus districts get one to five plant boxes; these sit last in the index buffer and are drawn within 2.2 km (`plantFar`).
- **Street life** (`src/world/props.js`, placed by `buildProps()` in the tile worker). About 39,000 palms along trunk-to-tertiary roads and in villa gardens, 8,700 shade trees in parks, 28,000 cars standing on the streets, 520 boats moored where the city map says water is within 250 m of land in the Marina, Palm and Burj Al Arab boxes. One instanced mesh per kind per 2 km cell, shown within 1.9 km (cars 1 km, boats 6 km). The motorway traffic now has car bodies as well as lights. Off in Low quality.
- **Windows with rooms** (`src/shaders/building.glsl.js`). Interior mapping: the view ray is cast into a box one bay wide, one floor high and 5 m deep, and the shader shades the wall, floor or ceiling it hits. It runs only where a window is resolved. Lit rooms at night show their ceiling and back wall with parallax; 30% have blinds drawn. Piers between bays tilt the normal, and punched windows have a shaded head.
- **Ground** (`src/world/land.js`). Car parks with bay lines and parked cars in built-up blocks, scrub on open sand, both only where a pixel is under about a metre.
- **Sky** (`src/world/sky.js`). Two octaves of noise stretched into high thin cloud, lit by the sky colour and the low sun.
- Frame time along the tour at 1920x1080 on Intel Iris Xe: 9.4 to 13.2 ms (350 K to 850 K triangles, up to 160 draw calls). The first try, with 52,000 palms of 74 triangles each, pushed a frame past 1.2 M triangles; palms are now 36 triangles.
- Limits: car parks are aligned to the world axes, not to the streets. Palms can stand in a building's forecourt or on a bridge approach. Street cars do not move. Trees cast no shadows.

**Lighting pass (2026-11-13).** Third verdict: still fake, everything except the sea, everywhere. Asked what "right" looks like, the owner chose a film-like aerial shot of a clean architectural model. So the target changed from "more things" to "better light, fewer patterns". The sea was the clue: it is smooth, softly lit and has no repeating texture.
- **Crisp sun shadows** (`src/world/sunShadow.js`). One 2048² depth map fitted to what the camera looks at (700 to 2600 m half-width), drawn every fourth frame from buildings and landmarks only. `sunLight(p, n)` in the shared chunk uses it inside its box and fades to the height-map shadows at the edge. The light's view is a box along the sun, so far towers still shadow the view.
- **Contact shading** (`src/post.js`). SSAO from the depth buffer at quarter size, six samples, radius growing with distance, faded out past 5 km. High quality now always goes through the post pipeline.
- **Grade.** After tone mapping: a little contrast and saturation, cool shadows and warm highlights, vignette, grain.
- **Materials calmed.** Glass towers were a mosaic: every pane had its own tilt, blinds and brightness. Panes are now flat, one facade reflects as one sheet, and what it reflects is the sky with its clouds (`envColor()`; clouds live in a 512² texture, `src/world/clouds.js`, because noise per reflected pixel cost several ms). Painted roof squares, parking bays and plot lines are gone: patterns read as a printed texture.
- **Roads** (`src/world/roads.js`, `buildRoads()` in the worker). Drawn twice like a map: a wider pavement casing first, then the carriageway, so junctions merge and every road has a kerb. Markings are only lane dashes on motorways and trunk roads and a centre line on two-way main roads. Bridges (not motorways, not rail) rise up to 6 m per layer with ramps at free ends and skirts along the deck.
- **Tapered towers** (`taper()` in `src/data/buildingMesh.js`). Two thirds of towers of 90 m or more step in twice on the way up.
- Frame time along the tour at 1920x1080 on Intel Iris Xe: 12.3 to 16.8 ms, against 8.8 to 13.3 ms for the previous commit measured minutes apart. The governor takes the heaviest views down to 0.82 scale (13 ms). Do not add per-pixel noise to reflections or raise the shadow refresh rate without measuring both back to back: readings drift with the laptop's temperature.
- Limits: shadows inside the box are sharp, outside it still soft. A raised bridge that continues in the next tile ramps down at the tile edge. Street cars under a raised deck are not removed. Low quality has none of this.

**Evening and night pass (2026-11-13).** Fourth verdict, after the owner saw the screenshots: day is better, the evening lacks definition, night still looks fake.
- **Why the evening was mush.** The sky was orange in every direction, so the haze and every reflection were orange too, and the fill light was warm. `skyColor()` now keeps the orange horizon toward a low sun only; the far side is cool and dimmer. Golden hour and sunset have a stronger sun against a cooler, dimmer fill, less haze, and the sun stays 2.5° up at t = 0.64 so shadows last through sunset.
- **Windows mirror the sky they face** (`Rs` in the building shader), not the ground under the viewer. From the air a true mirror shows sand, which turned every facade brown.
- **Sharpening.** An unsharp mask in the final pass, from the four taps FXAA already takes.
- **Why night was fake.** Lit windows were a random checkerboard of large squares on black walls. Light now comes in runs: a flat spans 2 to 4 bays, an office floor is in use or dark as a whole (6 to 14 bays), bays inside a run vary and some are blinded. Glass towers have half-width bays. Lamp colour runs from amber to neutral white and is kept below the level where the tone curve bleaches it. Lit windows start later (4% at golden hour, 55% at night).
- **The city lights itself.** Stronger sodium wash on lower walls, lit ground in built-up blocks, brighter road pools and street lights, amber haze on the horizon, light streaks on water near the shore, head and tail lights on three street cars in five, and a thin band of white, amber or blue at the top of each tier on about four tall towers in ten.
- Frame time along the tour at 1920x1080 on Intel Iris Xe: 13.3 to 19.4 ms (previous commit 12.3 to 16.8 ms, measured on another run; treat as "about the same"). The governor trims resolution in the heaviest views.
- Limits: at mid distance lit windows are still blocks (6 bays by 2 floors). Crown lights follow tier tops, not real architectural lighting. Night in Low quality has no bloom.

### Phase 4 — polish, in two chats

Phase 4 is split by the kind of work, because the two kinds need different models and different rules.
Run them one after the other, never at the same time (both touch `src/app.js`). **4B first**: it is cheap, and its `?perf` overlay and URL parameters make 4A's work easier to measure and to look at.

Where the old task numbers went: 4.1 is 4B.1; 4.2 is done as the resolution governor, the rest is 4B.6; 4.3 is done; 4.4 is 4A.1 and 4A.2; 4.5 is 4A.6, 4B.2 and 4B.3; 4.6 is 4B.4 and 4B.5; 4.7 is 4A.8.

Both chats: `npm run check` (landmark meshes, tile meshing, tour clearance, no browser needed) and `npm run build` must pass before every commit. One commit per task. Commit on `master`, do not push.

#### Phase 4A — visual bugs (Fable 5.2)

These are judged by eye. **Screenshots are required in this chat**: nothing here can be verified by numbers, and the first version of Phase 3 was finished without anyone looking at it.

How to look at it:
- Start the dev server from `.claude/launch.json` (name `dubai-dev`, port 5173) in the preview pane. `window.__dubai` is the app: `env.setTime(t)`, `camera`, `controls`, `tour`, `landmarks.view(key)`, `frame(now)`, `stats()`, `res` (render scale), `setQuality('low' | 'high')`.
- To hold a view: stop the tour, set `controls.enabled = false`, set the time and the camera, call `frame(performance.now())` about 30 times (the shadow map refreshes every fourth frame), then screenshot. Hide `#chips`, `#title`, `#panel` for a clean frame; never hide `#credit` in anything that ships.
- Set the pane to 1280x720. On a 150% display the screenshot tool sometimes crops to the top-left two thirds; if a landmark that should be centred is not, shrink `#scene` to 66.667% width and height in the page before deciding it is a bug.
- Always look at the same view at t = 0.3, 0.5, 0.64, 0.75 and 1.0. Every pass so far fixed one time of day and exposed another.

How to measure: frame time at 1920x1080 on the owner's Intel Iris Xe is 13 to 19 ms along the tour, and readings drift by several ms as the laptop warms. The only comparison that holds is back to back: `git stash`, time the previous commit, `git stash pop`, time again (see BUILD_LOG.md, lighting pass). Budget: no slower than now, or the governor's scale (`__dubai.res.scale`) stays at 0.8 or above during the tour.

What the owner has said, in order: it lagged; it looked like Lego; everything except the sea looked fake; the target is a film-like aerial shot of a clean architectural model; day is now better, the evening needed definition, night looked fake. Lessons that cost a pass each: patterns (random per-window values, painted bays) read as a printed texture, smooth light reads as real; more objects did not help, better light did; never evaluate noise per reflected pixel; never feed an unclamped varying to `exp()`.

- [ ] 4A.1 Night from the air. At 1 to 4 km lit windows are blocks of 6 bays by 2 floors. Find something that reads as windows at that distance. `src/shaders/building.glsl.js`, the night block.
- [ ] 4A.2 Tower lighting at night. The crown bands just follow tier tops. A few towers need facade or edge lighting; check all five landmarks at night (Burj Khalifa's pattern, Burj Al Arab's fabric, Cayan). `src/shaders/building.glsl.js`, `src/landmarks/*.js`.
- [ ] 4A.3 Roads in three dimensions. A raised bridge that continues in the next tile ramps down at the tile edge. Motorways and the Metro are flat. Standing cars stay under raised decks, palms stand on bridge approaches. `buildRoads()` and `buildProps()` in `src/data/tileWorker.js`, `src/world/roads.js`, `src/world/traffic.js`.
- [ ] 4A.4 Shadows. Sharp only inside the box around the camera, soft beyond it; look at the seam. Trees and bridge decks cast none. Check for striping on walls at low sun. `src/world/sunShadow.js`, `sunLight()` in `src/shaders/common.glsl.js`.
- [ ] 4A.5 Landmarks by day. Burj Khalifa is plain from far away. The Museum of the Future's proportions and script. Cayan's twist does not read from its chip view. Dubai Mall is one flat slab beside Burj Khalifa.
- [ ] 4A.6 Tour framing and timing (54 s). Look at every keyframe at the time of day the tour reaches it. `src/camera/tour.js`; `npm run check` guards clearance.
- [ ] 4A.7 Low quality has no crisp shadows, contact shading, bloom or grade, so it looks like a different app. Decide what it keeps.
- [ ] 4A.8 Stretch, only if the rest is done: Dubai Fountain on the Burj lake at night, Atlantis arch, Metro viaduct.
- [ ] 4A.9 Update `BUILD_LOG.md` (what the screenshots showed, what changed, frame time back to back) and tick these boxes.

Prompt for the chat (Fable 5.2):

```
Read PLAN.md, then do Phase 4A (visual bugs), tasks 4A.1 to 4A.7 in order, 4A.8 only if there is budget left, then 4A.9.

This phase is judged by eye, so take screenshots: follow "How to look at it" in PLAN.md §5 and look at every change at t = 0.3, 0.5, 0.64, 0.75 and 1.0 before calling it done. Before you change anything, take the five-times set for one view from the air and one close to buildings, and tell me in a short list what you see wrong; then start.

Measure frame time back to back the way PLAN.md describes, and do not make it slower. Run npm run check and npm run build before each commit, one commit per task, on master, no push.

Do not touch the UI, the URL handling or index.html: those belong to Phase 4B. If a task turns out to need a decision from me (for example what Low quality should keep), ask once and carry on with the next task meanwhile.
```

#### Phase 4B — small fixes (Sonnet 5.5)

Plain engineering with clear answers. The no-screenshots rule stands here: check with the console, the DOM and `npm run check`. Do not change how anything is lit, shaded or shaped: `src/shaders/`, `src/world/`, `src/landmarks/`, `src/data/buildingMesh.js` and `src/post.js` are off limits except to read.

- [ ] 4B.1 `?perf` overlay: draw calls, triangles, frame time (smoothed), render scale and quality level, read from `window.__dubai.stats()` and `.res`. Then record those numbers at five fixed camera spots (tour seconds 0, 9, 27, 44, 54) in `BUILD_LOG.md`. Touches: `src/ui/`, `src/app.js`.
- [ ] 4B.2 URL parameters: `?t=0..1` (time of day), `?cam=x,y,z,tx,ty,tz` (camera and target in scene metres), `?notour`, `?q=low|high`. A parameter that sets the view also skips the tour. Touches: `src/app.js`, a small `src/ui/params.js`.
- [ ] 4B.3 `H` hides the overlay for recording. The OSM credit (`#credit`) stays visible in every state.
- [ ] 4B.4 A clear message when WebGL 2 is not available, and when a data file fails to load (the status line already reports the count; make sure the page is not left blank). Loading: the bar exists; keep the tour from starting before the first frame with the city in it.
- [ ] 4B.5 Phones and touch: start in Low on a coarse pointer or a narrow screen, check the panel and chips at 360 px wide, make sure one-finger orbit and pinch zoom work and that scrolling the page does not skip the tour. Respect `prefers-reduced-motion`: no automatic tour.
- [ ] 4B.6 Put the LOD distances and the governor's constants in one commented block at the top of `src/app.js` (they are spread over `QUALITY`, `src/world/props.js` and `src/world/sunShadow.js`); do not change their values.
- [ ] 4B.7 Housekeeping: commit `.claude/launch.json` or ignore `.claude/` (ask which); delete the empty `.gitkeep` files in folders that now have code; add "run it" and "check it" lines to `README.md`; add Sonnet 5.5 prices to `PRICES` in `scripts/usage.mjs` (look them up) and fill the Phase 2 cost in `BUILD_LOG.md`.
- [ ] 4B.8 §3 and §4 of this file describe the first design. Do not rewrite them; add a one-line "superseded, see §5" note to each paragraph that the Phase 3 notes overrule (post-processing, shadows, water draw order, bloom strengths, tour length).
- [ ] 4B.9 Update `BUILD_LOG.md` and tick these boxes.

Prompt for the chat (Sonnet 5.5):

```
Read PLAN.md, then do Phase 4B (small fixes), tasks 4B.1 to 4B.9 in order.

Keep to the files each task names. Do not change anything in src/shaders/, src/world/, src/landmarks/, src/data/buildingMesh.js or src/post.js: the look of the scene is Phase 4A's job, and a change there cannot be judged without screenshots, which this phase does not take.

Check each task without screenshots: no console errors on load, the DOM and window.__dubai state are what the task says, npm run check and npm run build pass. One commit per task, on master, no push.

Where a task says "ask", ask me once and carry on with the next task meanwhile. At the end, list anything you noticed that looks like a visual bug but did not touch, so it can go to Phase 4A.
```

### Phase 5 — README, deploy, launch
- [ ] 5.1 `README.md`: what it is, how it was built, how to reproduce the data, credits, ODbL notice
- [ ] 5.2 `.github/workflows/deploy.yml` for GitHub Pages (Vite `base: './'` is already set), or Vercel
- [ ] 5.3 Final cost table in `BUILD_LOG.md`: tokens per phase × Fable 5.2 ($8 in / $40 out per M) and Sonnet 5.5 rates (look up current pricing, including cache read/write rates)
- [ ] 5.4 Launch post draft with the headline number, a short clip or GIF plan, `LAUNCH.md`

---

## 6. Risks and fallbacks

| Risk | Signal | Fallback |
|---|---|---|
| ~90% of heights are estimated | Stats: estimated towers ≥ 150 m in odd places; flat-looking skyline | `data/overrides.json` for the ~30–50 best-known towers; tune the zone table; cap estimates at 260 m so no fake tower rivals a real supertall |
| Overpass refuses or is busy (seen today: 406 with a generic User-Agent, 502 "at capacity"; mirrors `overpass.private.coffee` and `overpass.kumi.systems` were unreachable from this machine) | Non-200 or an HTML body | Descriptive User-Agent, backoff, cached raw files so only failed cells re-run, smaller grid cells (4×4). Last resort: Geofabrik `gcc-states-latest.osm.pbf` + `osmium extract` |
| Coastline stitching produces inverted or open land | Stats: land area far from ~55% of `world`; sea where the city is | Check winding per chain and flip. If still wrong, close chains against the bbox with a point-in-land test at a known inland point (Mall of the Emirates, 25.118, 55.200) |
| Water subtraction fails on bad polygons | `polygon-clipping` throws | Skip the offending polygon and log it; or skip subtraction and draw inland water as flat patches at +0.1 m with the water material |
| `building:part` double-counts or strips towers | Stats: buildings with both outline and parts; missing known towers | Turn the parts step off (`--no-parts`) and use outlines only |
| Frame rate under 60 fps | `?perf` overlay | In order: lower DPR, bloom off, tighter LOD distance, Tier B threshold up, minor roads off beyond 3 km |
| Night windows shimmer or alias | Visible when moving | Distance fade to average glow (already planned), `fwidth`-based filtering of the grid |
| Depth fighting on roads and land | Flicker at distance | `polygonOffset`, larger y gaps at distance, raise `near` |
| Data over budget | `data:stats` fails the cap | Thresholds in §2 |
| Usage limits cut a phase mid-task | – | Every task is one commit; the next chat reads this file and resumes at the first unticked box |
| Attribution missed | – | The credit is in `index.html` from day one; keep it visible in every UI state, including recording mode |
