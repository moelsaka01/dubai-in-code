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
| Claude Sonnet 5.5 | to fill | to fill | look up at Phase 5 and add to `PRICES` in `scripts/usage.mjs` |

The cache multipliers are assumptions in `scripts/usage.mjs`. Confirm them against current pricing in Phase 5 before publishing a number. Most of the token volume is cache reads, so they matter.

## Phases

| Phase | Model | Prompts | Time | Input | Output | Cache read | Cache write | API-equivalent |
|---|---|---|---|---|---|---|---|---|
| 1 Plan and skeleton | Fable 5.2 | 2 | ~41 min | 40 | 54,001 | 2,178,702 | 87,950 | $5.31 |
| 2 Data pipeline | Sonnet 5.5 | 8 | ~526 min wall clock | 112 | 75,598 | 6,760,624 | 373,234 | price not set (Phase 5) |
| 3 Rendering and landmarks, with review pass | Fable 5.2 | 3 | ~106 min+ | 168 | 337,927 | 26,490,167 | 473,853 | ~$42.29 |
| 4 Polish and performance | | | | | | | | |
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
