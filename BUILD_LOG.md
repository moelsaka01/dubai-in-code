# Build log

One entry per phase, written at the end of that phase's chat. This file feeds the headline: "Claude Fable 5.2 built Dubai in 3D from map data, for $X".

## How to read token usage

At the end of each phase, before closing the chat, run this in the project folder:

```bash
npm run usage
```

It reads the session transcripts Claude Code keeps on this machine (`~/.claude/projects/<folder-slug>/<session-id>.jsonl`), and prints for each session: start and end time, number of user prompts, and tokens per model split into input, output, cache read and cache write. Copy the line for the phase's session into the table below. Or ask Claude at the end of the chat: "run `npm run usage` and update BUILD_LOG.md".

Notes:
- If the project folder moves, older sessions stay under the old folder's slug. Pass that folder explicitly: `npm run usage -- <path-to-folder-or-.jsonl>`.
- A session measured from inside itself misses its last few turns. Re-run after the chat ends for the exact figure.
- Other ways to look: `/context` in Claude Code shows the current context size, `/usage` shows plan limits. Neither gives per-session token totals, which is why the script exists.

## Cost method

API-equivalent cost = input × P_in + output × P_out + cache read × 0.1 × P_in + cache write × P_in × (1.25 for 5-minute cache, 2 for 1-hour cache).

| Model | Input $/M | Output $/M | Source |
|---|---|---|---|
| Claude Fable 5.2 | 8 | 40 | given in the project brief |
| Claude Sonnet 5.5 | 2 | 10 | third-party price trackers, 2026-11-13 (Anthropic's own page could not be opened); cache read $0.20, 5-minute write $2.50, 1-hour write $4 per M are in line with the script's multipliers. Re-check in Phase 5 |

The cache multipliers are assumptions in `scripts/usage.mjs`. Confirm them against current pricing in Phase 5 before publishing a number. Most of the token volume is cache reads, so they matter.

## Phases

| Phase | Model | Prompts | Time | Input | Output | Cache read | Cache write | API-equivalent |
|---|---|---|---|---|---|---|---|---|
| 1 Plan and skeleton | Fable 5.2 | 2 | ~41 min | 40 | 54,001 | 2,178,702 | 87,950 | $5.31 |
| 2 Data pipeline | Sonnet 5.5 | 8 | ~526 min wall clock | 112 | 75,598 | 6,760,624 | 373,234 | $3.60 |
| 3 Rendering and landmarks, with four review passes (v0.1.0) | Fable 5.2 | 9 | ~19 h wall clock | 322 | 526,491 | 73,094,893 | 2,671,274 | ~$122.28 |
| 4B Small fixes | Sonnet 5.5 | 1 | ~10 min | see `npm run usage` | | | | ~$1.5 (in progress) |
| 4A Visual bugs | Fable 5.2 | | | | | | | |
| 5 README, deploy, launch | | | | | | | | |
| **Total** | | | | | | | | |

Phases 1 and 2 are final figures, read on 2026-11-12 during Phase 3. Phase 3 (including its review pass) was measured from inside its own session just before the last commit, so it misses the final turns. Re-run `npm run usage` for the exact number.

### Phase 1 — plan and skeleton (2026-11-12)

**Done:** `PLAN.md`, Vite + Three.js skeleton that builds, shared geography config, usage script, first commit.

**What went wrong:**
- Overpass rejected the first probe with HTTP 406 because of a generic `curl` User-Agent. A descriptive User-Agent fixed it.
- Overpass then answered 502 "at capacity" once and succeeded on retry. Two public mirrors were unreachable from this machine. Both findings are in the Phase 2 fetch design (PLAN.md §1 and §6).
- A name lookup found four of the five landmarks. Burj Al Arab did not match by exact name, so its coordinates are from memory and flagged for Phase 2 task 2.2.
- `curl` on Windows could not read a query file given as a Git Bash path. Running from the file's folder with a relative path worked.

**Findings that shaped the plan:** 100,281 buildings in the full area, only 2.2% with a `height` tag and 7.6% with `building:levels`. The whole Palm has ~2,700 buildings, so v1 includes all of it.

### Phase 2 — data pipeline (2026-11-12)

**Done:** `npm run data:fetch && npm run data:build` produces `public/data/`; `npm run data:stats` prints the report and exits 1 over the hard cap. Raw cache is 55 MB in `data/raw/` (gitignored). No git repository exists in the folder, so none of the per-task commits happened.

**Result (OSM base 2026-11-12):** 64,910 buildings (26,429 Tier A, 38,481 Tier B) in 98 tiles, 15,709 road pieces, 293 land polygons plus 808 green and 78 beach. Total 2.81 MB raw, 2.27 MB gzip (target 4.5 / 2.5, cap 8). Largest tile 112 KB. Height sources: tag 4.0%, levels 7.4%, estimate 88.7%, override 0%. Land is 57.6% of the world bbox; Mall of the Emirates is on land and the NW Gulf corner is sea. SZR came out as two 27.6 km carriageway lines. Whole pipeline runs in about 4 s once the raw files are cached.

**What went wrong or changed:**
- `out tags geom` drops relation members, so all 416 building relations and the water relations came back empty. Fixed by fetching relations with `out body geom` (`q1rel_world.json`, and a split query for `q4_water.json`). One 502 on the way, handled by the backoff.
- Burj Al Arab: Q6 only found a node. The way is tagged with an Arabic name. Its footprint is way 12700546 (4,427 m²) and has `height=321`. Config corrected (lon 55.1853 -> 55.18556, osm id added). Q6 also missed Burj Khalifa by name (same reason); the config id was right.
- Height estimator deviates from the PLAN table: in marina/downtown the top of the tower range is only reachable with a large footprint (reach = clamp((area-300)/1500, 0.25, 1)). The literal table gave 452 estimated towers >= 150 m, about twice the real count for those zones. Now 50 estimated and 365 in total at >= 150 m.
- Overrides never fire at present: every known tower already carries a height tag in OSM, and overrides only apply when no tag exists. Names are in the file for the day a tag is wrong.

**Open points for later phases:**
- Palm trunk axis: now derived from the built land polygon (foot 25.1018, 55.1480 to crown centre 25.1180, 55.1336, ~2.3 km). The first hand-estimated axis ran over open sea for its first 1.3 km.
- Museum of the Future: the named way 33875310 is not a building polygon, so the landmark footprint/rotation comes from the largest outline inside the clear radius (way 1054289435, 4,626 m²).
- Landmark clearing checked by listing every drop: Burj Khalifa's 37 are all its own OSM parts plus its 15 m podium pieces; Burj Al Arab's 4 are the hotel, two tiny pavilions and the Skyview Bar that sits on the tower. Nothing to change. Two podium blocks sit just outside the Burj Khalifa radius (98-99 m) and will stay as low blocks beside it.
- Ways that are outer members of a building relation are now skipped (14 of them) so they are not drawn twice.
- `data/build-report.json` is a by-product (tallest buildings with names) read by `data:stats`; it is small and kept with the sources.
- Many buildings with Arabic-only `name` tags; override matching also tries `name:en`.

### Phase 3 — rendering and landmarks (2026-11-12)

**Done:** the city loads and renders, the slider runs noon to night, the five landmarks stand on their OSM footprints, the tour plays and any input skips it. `npm run build` passes (655 KB JS, 168 KB gzip; worker 19 KB). The phase was written and checked as a whole, then committed as one commit per task in plan order, so only the last commit of the phase runs on its own.

**Result:** 86 building tiles (1.93 M vertices, 1.03 M triangles in total), 117 K road triangles, 8,698 street lights, 365 beacons, 1,500 cars, land 80 K triangles. Five landmarks in 8 draw calls and about 26 K triangles (Burj Khalifa 2.6 K, Ain Dubai 11.9 K with capsules, Cayan 2.1 K, Burj Al Arab 3.1 K, Museum 6.1 K). A frame is 54 to 137 draw calls and 350 K to 490 K triangles at the views tested (budget 250 and 1.2 M). The worker meshes all 98 tiles in about 1 s.

**How it was checked (no screenshots, per the plan's rule):**
- Node: every landmark mesh has finite values and outward faces; the building meshes enclose 680.1 Mm³ against 680.1 Mm³ computed from the footprints, which proves walls and roofs face outward; land and road triangles face up; the tour path clears every building of 60 m or more.
- Browser: no console or shader errors; pixel blocks sampled at noon, golden hour, blue hour and night in both quality levels; each landmark's pixels compared with the landmark hidden; tour, slider, quality buttons, chips, WASD and the OSM credit driven by script.
- Not checked: how it actually looks. Nobody has seen a frame yet. Frame time was only measured in a 786x799 pane on Intel Iris Xe, where it sat at the 16.6 ms vsync limit; the 1080p number is Phase 4.1.

**What went wrong:**
- Night was far too bright at first: about 70% of windows lit at 1.5 gave whole facades an average glow near white. Now a building lights 10 to 60% of its rooms, most of them dim and a few bright enough to bloom.
- With bloom on, the lower half of the frame went white at dusk and night. The cause was one line: `exp(-height / 9)` for the street-light wash on walls. Under MSAA the height varying is extrapolated far below zero on walls seen edge-on, the exponential overflows, and the bloom pass spreads those pixels over the frame. Without bloom the same pixels just clip to white and nobody notices. Fixed by clamping the height. Found by rendering each layer alone into a float target and reading back the maximum.
- While chasing that, bloom strength was cut from 0.85 to 0.4 at night. That part stays: UnrealBloomPass adds its five mips with weights that sum to about 3.
- The Museum of the Future chip pointed the camera at the back of a neighbouring tower. A scan of 12 bearings picked the clear side.
- The first tour path came within 25 m of a 303 m Marina tower and a 150 m Downtown tower. Raised three keyframes.
- The OSM min-area rectangle is useless for Y-shaped and wedge-shaped footprints, so Burj Khalifa's wing angles (22.5°, 142.5°, 262.5°) and Burj Al Arab's mast corner and axis (37.6° south of east) were read from the raw outlines.

**Open points for Phase 4:** look at it and tune colours; bloom and window levels at night; the tour is 54 s; bridges are flat; the Metro is a flat ribbon; the Museum's proportions are a compromise between the plan (roughly round) and the 140 m OSM footprint; `.claude/launch.json` (dev server for the preview pane) is untracked.

### Phase 3 review pass (2026-11-12)

The first version was finished without anyone looking at it. Then it was looked at, with screenshots, and the owner's verdict was short: the tour lags, and the whole thing looks fake, like Lego, the Museum of the Future most of all.

**What the screenshots showed:** the water had a regular ripple pattern with moire rings; distant buildings at night were flat grey boxes; Burj Khalifa at night was a pale cutout; the Museum was a fat white doughnut with blue squiggles; a building part floated in the sky over the Marina; the Cayan chip pointed at the back of another tower; Ain Dubai's spokes filled the wheel at night; the chips covered the status line in a narrow window; roads were near-black; car lights showed as blobs by day.

**Frame time.** Measured along the tour at 1920x1080 on Intel Iris Xe:

| | ms per frame |
|---|---|
| First version (measured at 1280x720: 9.4 to 12.2 ms, scaled by pixel count) | about 21 to 27 |
| New shaders and shadows, own bloom chain, 4x MSAA float target | 13.2 to 20.1 |
| Same, 2x MSAA | 13.4 to 16.0 |
| Same, no MSAA, FXAA in the final pass (shipped) | 8.6 to 11.3 |

The cost was never the geometry. It was `EffectComposer` + `UnrealBloomPass` resolving a multisampled float target twice a frame. A full shadow-map update costs 18 ms and is spread over 24 frames.

**Realism.** Sun shadows and ambient occlusion from a top-down height map; tower crowns; four facade types with shopfronts, plant floors and parapets; glass that mirrors sky and ground; paving where the city is dense; noise-based water with turquoise shallows and surf; night windows that stay windows at a distance. The Museum of the Future was rebuilt as brushed steel with rows of script. Details and the reasons are in PLAN.md §5.

**What went wrong on the way:**
- The resolution governor's first version shrank the picture to half size inside the preview pane, where the browser throttles frames. Lower resolution could not help there. Now every reduction is a trial that is undone if the frame time does not improve.
- Glass towers came out nearly black in the first pass: a mirror seen from above reflects the ground, and the ground colour in the reflection was too dark and the horizon too sharp.
- Ambient occlusion made the whole Marina look sooty until its strength and range were cut.
- The preview pane's screenshots crop to the top-left two thirds at 150% display scaling. Several "framing bugs" were that, checked by projecting the landmark to screen coordinates (it was dead centre).

**Not done:** shadows are coarse (11.7 m texels) and get fat with distance; villas cast almost none. Burj Khalifa by day is plain from far away. Bridges are still flat. The frame time was measured with forced frames and `gl.finish()`, not from a long real run.

### Detail pass (2026-11-13)

The review pass fixed the frame rate, and the owner confirmed it. The second note stood: it still looked like Lego. Shadows and better facades had not changed what the city was made of, which was extruded footprints standing on empty ground.

**Added:** podiums under large towers, pitched roofs on villas, plant on flat roofs; 39,000 palms, 8,700 trees, 28,000 street cars, 520 boats, car bodies on the motorways; rooms behind the windows (interior mapping), piers and window reveals; car parks and scrub on the ground; thin cloud in the sky. All of it is derived from the roads, footprints, parks and coastline already in `public/data`. Nothing was added to the data and no asset was loaded.

**Frame time** along the tour at 1920x1080 on Intel Iris Xe: 9.4 to 13.2 ms, against 8.6 to 11.3 ms before the detail. Readings on this laptop drift by 2 to 4 ms between runs, so treat the difference as "a little more", not as a number.

**What went wrong:**
- The first palm had 74 triangles and there were 52,000 of them. A frame went past 1.2 M triangles. Cut to 36 triangles, wider spacing and a shorter draw distance.
- Interior mapping and the ground detail ran for every pixel at first. Both now run only where the detail can be seen.
- At night the water near every shore glowed like lit sand: the "city lights on the water" term was four times too strong.
- The session was cut off once mid-pass. The work was uncommitted but on disk, and resumed from `git status`.

**Not done:** street cars stand still; car parks ignore street direction; trees and palms cast no shadows; no people.

### Lighting pass (2026-11-13)

Third verdict: still fake. This time the question went back to the owner in three parts. Answers: everything looks fake except the sea, roads included; equally in every view; and the goal is a film-like aerial shot of a clean architectural model. Two earlier passes had guessed "missing detail" and added objects. The answer pointed the other way: the sea, the one thing that worked, has no objects and no patterns, only smooth colour and soft light.

**Changed:** a real shadow map around the camera for crisp shadows; contact shading (SSAO); a camera-style grade; glass that reflects as one smooth sheet with clouds in it; painted patterns removed from roofs and ground; roads drawn as pavement plus carriageway so junctions merge, with raised bridges; towers that step in as they rise.

**Frame time** along the tour at 1920x1080 on Intel Iris Xe: 12.3 to 16.8 ms. The commit before measured 8.8 to 13.3 ms a few minutes earlier on the same warm laptop. The resolution governor covers the difference in the heaviest views (13 ms at 0.82 scale).

**What went wrong:**
- The first version cost 14 to 22 ms. Toggling parts on the live page gave contradictory answers because the laptop was heating up between readings. What settled it was stashing the work, timing the previous commit, and restoring: a true back-to-back comparison.
- The causes, in order: cloud noise evaluated in every reflected pixel (moved to a texture), contact shading at half size (now quarter size), and the shadow pass at about 7 ms per refresh (now every fourth frame, towers only beyond 1.4 km, no trees).
- A ternary in GLSL does not skip the unused side on this GPU: "glass ? clouds : plain" still paid for the clouds everywhere.
- Contact shading turned to blotches on the far sea, where depth is coarse. Faded out past 5 km.
- A WebGL error went unnoticed until a final check: while the city loaded, the shadow sampler was bound to a texture that was not yet a depth texture, and the browser rejected every draw for about 60 frames. The earlier checks only read the error flag after loading. Fixed by allocating the shadow map when it is created; load, High and Low now run with no GL errors.
- Stashing files under a running dev server produced one HTTP 500 for a missing module. Harmless, but it stays in the browser console and looked like a new error twice.

**Not done:** trees and bridges cast no crisp shadows; street cars under raised decks; Low quality is unchanged.

### Evening and night pass (2026-11-13)

The owner looked at the screenshots from the lighting pass: day better, evening short on definition, night still fake.

**Evening.** Looking at one view at t = 0.5 showed a single orange-brown tone: orange sky all round, orange haze, windows reflecting sand. Three changes fixed most of it: an orange horizon only toward the sun, windows that reflect the sky they face, and a stronger sun against a cooler fill. Plus a sharpening step.

**Night.** The same view at t = 1 showed a checkerboard of white squares on black. Lit rooms now come in horizontal runs with amber-to-white lamp colours, and the city lights its own walls, ground, roads and water. Close to a building it now looks like a building at night. From the air the street network glows under an amber haze.

**What went wrong:**
- The first version of the runs came out white, with crown lights as thick glowing hoops. Brightness above about 0.8 is bleached by the tone curve, so lamp light has to stay dim to stay amber; the crown band went from 2.8 m to 1.2 m and from 55% to 38% of towers.
- Mid-distance window blocks were uniform, which read as tiles. They now vary in brightness.

**Not done:** real architectural lighting on towers (edges, facades); moving traffic on ordinary streets; the mid-distance window blocks are still visible as blocks.

### Version 0.1.0 accepted (2026-11-13)

The owner accepted the state after the evening and night pass as version 0.1.0: "I will allow it for a 0.1.0 version". Not praise, a stopping point. Phase 3 took one build and four review passes, nine prompts and about $122 at API-equivalent prices, against roughly $20 for the first build alone. Most of that was spent finding out what "fake" meant: the first two passes answered a different question (lag, then missing detail) from the one that mattered (light and patterns).

What carried over to Phase 4 is in PLAN.md §5, split in two chats: 4B small fixes for Sonnet 5.5 (perf overlay, URL parameters, touch, messages, housekeeping) and 4A visual bugs for Fable 5.2 (night from the air, tower lighting, roads in three dimensions, shadow seam, landmarks by day, tour framing, Low quality). Each has its prompt in the plan.

Added for both: `npm run check` (`scripts/check.mjs`), the Node checks used all through Phase 3, now in the repo: landmark meshes, tile meshing on the real data, tour clearance.

## Phase 4B — small fixes (Sonnet 5.5)

### 4B.1 `?perf` overlay

`?perf` shows a corner readout: smoothed frame time and fps, draw calls, triangles (thousands), render scale and quality level. Source: `src/ui/perf.js`, fed from `app.stats()` and `app.res` once per frame.

Reference numbers at the five fixed tour spots (tour seconds 0, 9, 27, 44, 54), High quality, pose and time of day taken from `tourPose()` / `tourTime()`. Measured in the preview pane (1024x768 at DPR 1.5, 86 tiles loaded) with forced frames and `gl.finish()`, 30 warm-up frames and 30 timed. The pane was hidden, so `requestAnimationFrame` did not run and times are indicative only (they are far from the 1920x1080 Iris Xe tour readings of the earlier passes). Draw calls and triangle counts are exact for those views.

| Tour s | t | Draw calls | Triangles | Frame ms (indicative) | Scale |
|---|---|---|---|---|---|
| 0 | 0.50 | 210 | 623 K | 8.2 | 1.00 |
| 9 | 0.53 | 227 | 978 K | 36.7 | 1.00 |
| 27 | 0.79 | 180 | 876 K | 59.9 | 1.00 |
| 44 | 0.99 | 90 | 885 K | 25.6 | 1.00 |
| 54 | 1.00 | 193 | 1 029 K | 87.9 | 1.00 |

Re-measure on the owner's laptop with `?perf` before comparing anything in Phase 4A.

### 4B.2 to 4B.8 summary

- **URL parameters** (`src/ui/params.js`): `t`, `cam`, `notour`, `q`, `perf`. Bad values are ignored; `t` or `cam` skips the tour; tiles load nearest to the `cam` position. OrbitControls clamps a very shallow `cam` upward (polar angle limit), so the camera y can end a little above what was typed.
- **H** hides title, chips, panel and the perf readout (class `hud-hidden` on body). The tour keeps playing; `#credit` is not in the rule.
- **Failures** (`src/ui/fatal.js`): no WebGL 2, a failed start, a failed manifest or every data file failing each show a full-page message instead of a blank page. Some tiles failing still shows the city and reports the count. The tour now starts at the end of the first frame rendered with the city loaded.
- **Phones:** Low on a coarse pointer or a screen under 600 px; `?q` overrides. No automatic tour with `prefers-reduced-motion` (the Play button still works). 360 px wide: no horizontal overflow, panel and chips do not overlap; the perf readout moves under the chips. `overscroll-behavior: none`. Touch orbit and pinch are OrbitControls defaults and `touch-action: none` is on the canvas; not tried on a real touch device.
- **Constants:** `QUALITY` and a new `GOVERNOR` block at the top of `src/app.js`, same values. The `props.js` and `sunShadow.js` numbers are described there, not moved, because `src/world/` is off limits in 4B.
- **Housekeeping:** `.gitkeep` files removed, README has run and check lines, Sonnet 5.5 added to `PRICES` ($2 / $10, from third-party trackers; Anthropic's page was not reachable), Phase 2 cost $3.60. `.claude/` is still untracked, waiting for the owner's answer.
- **PLAN.md:** 14 "Superseded" notes in §3 and §4.

**Process slip:** another session was editing `src/shaders/building.glsl.js` in the same checkout. My `git add src` in 4B.5 and `git add -A` in 4B.7 swept its work-in-progress into those two commits. The file is still modified in the working tree.

## Phase 4A — visual bugs (Fable 5.2, 2026-11-13 to 14)

Judged by eye this time. Every change was looked at in the preview pane at t = 0.3, 0.5, 0.64, 0.75 and 1.0, from the air over the Marina and from street level by Cayan Tower, plus the view each task needed.

**What the first screenshots showed, before any change:**
- Night from the air: fat white rectangles on black towers, like a QR code. Close up the runs worked but were near-white, and the walls between them were pure black.
- Night sky: a flat brown band over the lower half of the sky in every direction.
- Tower crowns: the same thin white outline on every tier top.
- Day from the air: every tower the same pale blue. Burj Khalifa a beige spike.
- Roads: junctions were flat grey blobs, ramps lay on the sand, palms stood in carriageways.
- Cayan: a uniform grid by day, a white checkerboard by night.

**What changed, task by task:**
- **4A.1 Night from the air.** The 6-bay by 2-floor blocks were a second, coarser pattern. Now one function draws the lit runs at every distance: under a pixel per bay a run is a dash one floor high, under a pixel per floor it blends with the next floor, beyond that the wall takes the mean. Runs are shorter (1 to 3 bays for flats, 3 to 10 for offices), most are dim and a few bright, lamp colours are warmer, and facades take a faint fill from the sky glow.
- **4A.2 Tower lighting.** About half the tall towers carry one of four schemes (tier lines, corner LED strips, a washed crown, podium floodlights) in white, amber, blue or teal. Burj Khalifa: each setback lights the tier above it. Cayan and Burj Al Arab: rooms in runs. Museum script 40% dimmer. The night horizon glow is tighter and less brown.
- **4A.3 Roads in three dimensions.** `scripts/build-bridges.mjs` reads the shipped tiles and writes `public/data/bridges.json` (4.6 KB): for every point where bridge ways meet, the distance along bridges to the ground. 413 raised ways, 139 joints. Decks now join across tiles and between ways without steps; motorway bridges and rail bridges (the Palm monorail) rise too, motorway traffic follows the deck, and decks stand on piers placed clear of the roads below. Palms are refused where they would stand within 1.6 m of another road (34,479 down to 25,396), cars where they would stand under a deck.
- **4A.4 Shadows.** Decks, piers, and (when the shadow box is under 1100 m half-width) palms and trees are drawn into the sun shadow map. No striping on walls at t = 0.5 or 0.64 and no visible seam from the air, so `sunLight()` was left alone.
- **4A.5 Landmarks by day.** Burj Khalifa's glass mirrored the sand under the camera; landmark glass can now mirror the sky it faces, and each tier ends in a dark band. Cayan: stronger columns and a dark recess up each corner, so the twist reads. Museum chip view from below the void. Roofs over 5000 m² (Dubai Mall is 247,000 m²) carry large low volumes. Glass towers differ in tint and reflectance.
- **4A.6 Tour.** Opening 1.3 km from Ain Dubai instead of 2.4 km; the leg over empty sea to Burj Al Arab is lower, has one more keyframe and passes at 760 m; over the fountain lake the whole spire is in frame. Still 54 s, top speed 1020 m/s (was 1212).
- **4A.7 Low quality.** Same pipeline as High with DPR 1, no contact shading, shadow map every 8th frame, no tree shadows or roof plant, props at 35% reach. A device that cannot hold it at the governor's smallest scale drops to the old bare mode. This was the owner's decision to make; it is the default taken in their absence.
- **4A.8 Stretch.** Dubai Fountain only: 46 jets on the Burj lake, one draw call. Atlantis arch and Metro piers not done.

**Frame time, back to back.** GPU time per frame from `EXT_disjoint_timer_query_webgl2`, 1920x1080, mean of 16 frames at tour seconds 0, 9, 17, 27, 35, 44, 54, the old commit (c7f45c9) and the new code in two tabs of the same browser, read alternately:

| | 0 | 9 | 17 | 27 | 35 | 44 | 54 |
|---|---|---|---|---|---|---|---|
| v0.1.0 (c7f45c9) | 12.1 | 16.0 | 13.1 | 12.5 | 12.7 | 12.9 | 14.8 |
| after 4A.8 | 12.4 | 14.5 | 11.6 | 10.7 | 12.6 | 13.3 | 15.8 |

No slower within the noise (about ±1.5 ms between readings of the same code). The tour keyframes at 0, 27 and 44 s moved in 4A.6, so those columns compare slightly different views. Low: about 8.8 ms against 15.3 ms for High at two fixed views (old Low about 5.5 ms).

**How it was measured, and why not the way PLAN.md says:**
- `git stash` was not used. A Phase 4B chat was working in the same folder for the first two tasks; stashing would have taken its uncommitted work away. The old commit was checked out as a second worktree in a temp folder and served on another port instead.
- The preview pane was hidden for the whole session, so wall-clock frame times were capped at 16.6 ms or doubled by contention (one spot read 18 and 32 ms minutes apart). GPU timer queries were steady once the other chat had finished. These are GPU times, not frame times: they leave out JavaScript and presentation, so do not compare them with the 13 to 19 ms in the earlier sections.
- Not measured: a real run of the tour on a visible window, and the governor's scale during it. That is still to do on the owner's laptop with `?perf`.

**What went wrong:**
- The first version of 4A.1 turned glass towers into zebra stripes: office floors were lit across their whole width, and a faithful blur of a bar is a bar. The fix was in the near pattern, not the far one.
- The baseline tab rendered at 1024x768 while the working tab rendered at 1920x1080 (a background tab does not get the resize event), which made the new code look twice as slow for one reading.
- Edits to `buildingMesh.js` did not reload the page: it is imported only by the worker. The mall roof looked unchanged until a manual reload.
- The first Low measurement was taken at render scale 0.82, left by the governor during loading.

**Not done, or still weak:**
- At blue hour some glass towers turn saturated magenta (a warm-tinted glass reflecting the sunset sky).
- Bridge piers are plain square columns and overlapping ways each bring their own, so some interchanges are crowded with them. Decks in a neighbouring tile are not known to the palm and car filters.
- Shadows beyond the box are still the soft height-map ones.
- Burj Khalifa close up at night shows lit rooms as a grid of squares.
- Low's new cost has only been measured on this machine's GPU; phones are untested.
