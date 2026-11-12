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
| 1 Plan and skeleton | Fable 5.2 | 1 | ~16 min | 18 | 48,976 | 859,723 | 81,794 | ~$3.96 |
| 2 Data pipeline | Sonnet 5.5 | 1 | | | | | | run `npm run usage` |
| 3 Rendering and landmarks | Fable 5.2 | | | | | | | |
| 4 Polish and performance | | | | | | | | |
| 5 README, deploy, launch | | | | | | | | |
| **Total** | | | | | | | | |

Phase 1 figures were measured just before the commit, so they miss the final turns. Re-run `npm run usage` for the exact number.

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
