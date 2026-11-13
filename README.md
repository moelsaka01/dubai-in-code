# Dubai in Code

A 3D model of Dubai that runs in the browser, generated entirely from OpenStreetMap data and code.
No 3D software, no downloaded 3D models, no AI image or 3D asset generators.

**Status:** version 0.1.0: the city, five landmarks, time of day and a tour all run. Phase 4 (polish) is under way; see PLAN.md.

- [PLAN.md](PLAN.md): scope, data pipeline, rendering architecture, task list, risks
- [BUILD_LOG.md](BUILD_LOG.md): what each phase cost in prompts, time and tokens

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

URL parameters: `?perf` (frame time, draw calls, triangles), `?t=0..1` (time of day), `?cam=x,y,z,tx,ty,tz` (camera and target, scene metres), `?notour`, `?q=low|high`. Press `H` to hide the overlay for recording.

## Check it

```bash
npm run check        # landmark meshes, tile meshing on the real data, tour clearance (no browser)
npm run build        # production build into dist/
```

## Rebuild the data (from Phase 2)

```bash
npm run data:fetch   # OpenStreetMap via Overpass -> data/raw/ (not committed)
npm run data:build   # data/raw/ -> public/data/ (committed)
npm run data:stats   # sizes, height sources, sanity checks
```

## Credits

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License (ODbL).
The processed files in `public/data/` are derived from OpenStreetMap and are shared under the same license.

Built with [Three.js](https://threejs.org/) and [Vite](https://vite.dev/).
