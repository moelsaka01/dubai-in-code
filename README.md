# Dubai in Code

A 3D model of Dubai that runs in the browser, generated entirely from OpenStreetMap data and code.
No 3D software, no downloaded 3D models, no AI image or 3D asset generators.

**Status:** Phase 1 of 5 (plan and skeleton). The page currently shows zone boxes and landmark anchors, not the city.

- [PLAN.md](PLAN.md): scope, data pipeline, rendering architecture, task list, risks
- [BUILD_LOG.md](BUILD_LOG.md): what each phase cost in prompts, time and tokens

## Run

```bash
npm install
npm run dev
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
