# Launch notes

## Headline

> I had Claude build Dubai in 3D, in the browser, from OpenStreetMap data and code only. 65,000 buildings, five hand-coded landmarks, noon to night. No 3D software, no downloaded models. About $179 of API-equivalent tokens.

Numbers to quote (all from BUILD_LOG.md): 64,910 buildings, 2.8 MB of data, 25 prompts, about $179 at API prices, 70% of it on one phase of "this looks fake" review rounds. Honest caveat to include: only about 11% of building heights are in OSM; the rest are estimated.

## Draft post (short)

I wanted to see how far "only map data and code" goes. Dubai Marina to Downtown, the Palm, Burj Al Arab: every building is an OpenStreetMap footprint, extruded and lit in the browser. Burj Khalifa, Burj Al Arab, Cayan, the Museum of the Future and Ain Dubai are generated from parameters.

The hard part was not geometry. Three review rounds of "it looks fake" ended when the fix turned out to be better light and fewer patterns, not more objects.

Try it: https://moelsaka01.github.io/dubai-in-code/. Code and the full build log with costs: https://github.com/moelsaka01/dubai-in-code. Map data © OpenStreetMap contributors (ODbL).

## Clip plan (15 to 20 s, 1080p, no UI)

Record with `?notour&q=high`, press `H` to hide the overlay (the OSM credit stays). Use `?t=` and `?cam=` for each shot, or the built-in tour (54 s) trimmed.

1. 0 to 5 s: Ain Dubai and JBR from the sea, `t=0.5` (golden hour).
2. 5 to 10 s: tour over the Palm and down the coast to Burj Al Arab.
3. 10 to 15 s: Burj Khalifa and the fountain lake, time slider sweeping to night.
4. Last 2 s: title card with the URL.

Tools: OBS or the Windows Game Bar at 60 fps, then trim and make a GIF (under 8 MB) with ffmpeg. Check `?perf` first so the clip is not recorded at a lowered render scale.

## Before posting

- [x] Push, enable Pages, confirm the live URL loads and shows the credit (done 2026-11-14: workflow green, page and data files return 200).
- [ ] Open it on a phone (the Low quality path is untested on real devices).
- [ ] Confirm Fable 5.2 cache prices, or say the cost is an estimate.
- [ ] Mention the OSM credit and licence in the post.
