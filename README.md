# Dubai in Code

A 3D model of Dubai that runs in the browser, generated entirely from OpenStreetMap data and code.
No 3D software, no downloaded 3D models, no AI image or 3D asset generators.

**Status:** version 0.1.0 plus the Phase 4 polish: the city, five landmarks, a noon-to-night slider and a 54 s camera tour all run.

## What it is

About 65,000 buildings, 15,700 road pieces, the coastline and the Palm, from Dubai Marina to Downtown, drawn live in WebGL. Burj Khalifa, Burj Al Arab, Cayan Tower, the Museum of the Future and Ain Dubai are modelled by code on their real OSM footprints. Everything else is OpenStreetMap geometry that the browser extrudes, roofs, lights and shades itself. Heights are known for only about 11% of buildings; the rest are estimated by district, so the skyline is a likeness, not a survey.

## How it was built

1. **Data** (`scripts/`): Overpass queries are cached in `data/raw/`, then projected to local metres, cleaned, given heights, simplified, tiled on a 2 km grid and packed into compact binary files (2.8 MB in `public/data/`).
2. **Meshing** (`src/data/`): a Web Worker decodes each tile, triangulates roofs with earcut, and builds walls, crowns, podiums, road ribbons, bridges, palms and cars.
3. **Light** (`src/shaders/`, `src/world/`, `src/post.js`): one building shader with interior-mapped windows, a camera-fitted sun shadow map, a city height map for distant shadows, an analytic sky and water, and a small bloom, SSAO and grade chain.
4. **Landmarks** (`src/landmarks/`): five modules that generate their geometry from parameters. No model files.

Written with Claude: Fable 5.2 for planning, rendering and visual work; Sonnet 5.5 for the data pipeline and small fixes. [BUILD_LOG.md](BUILD_LOG.md) has the prompts, the dead ends and the cost.

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

## Deploy

`.github/workflows/deploy.yml` runs `npm run check` and `npm run build`, then publishes `dist/` to GitHub Pages on every push to `main` or `master`. In the repository settings set Pages > Source to "GitHub Actions". The Vite `base` is `./`, so it works under a sub-path. Any static host (Vercel, Netlify) also works with `npm run build` and `dist`.

## Credits

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License (ODbL).
The processed files in `public/data/` are derived from OpenStreetMap and are shared under the same license ([ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)). If you reuse them, keep the attribution and share derived databases alike. The code is not covered by the ODbL. The OSM credit stays visible in every state of the app.

Built with [Three.js](https://threejs.org/) and [Vite](https://vite.dev/).
