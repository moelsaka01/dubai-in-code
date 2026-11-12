// Downloads OSM data from Overpass into data/raw/. Usage: node scripts/fetch-osm.mjs [--force] [--grid N]
// Cached files are skipped, so a failed run can simply be restarted.
import { BBOX } from '../src/shared/config.js';
import { fetchCached } from './lib/overpass.mjs';

const force = process.argv.includes('--force');
const gi = process.argv.indexOf('--grid');
const N = gi > 0 ? Number(process.argv[gi + 1]) : 3;
import { fileURLToPath } from 'node:url';
const RAW = fileURLToPath(new URL('../data/raw/', import.meta.url));
const bb = (b) => b.join(',');

const [S, W, Nn, E] = BBOX.world;
const jobs = [];
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    const cell = [S + ((Nn - S) * j) / N, W + ((E - W) * i) / N, S + ((Nn - S) * (j + 1)) / N, W + ((E - W) * (i + 1)) / N].map((v) => +v.toFixed(5));
    const c = bb(cell);
    jobs.push([`q1_${i}_${j}.json`, `[out:json][timeout:180][maxsize:536870912];
( way["building"](${c}); way["building:part"](${c});
  relation["building"]["type"="multipolygon"](${c}); relation["building:part"]["type"="multipolygon"](${c}); );
out tags geom qt;`]);
  }
}
const w = bb(BBOX.world);
// Relations need "out body geom" to list members; "out tags geom" omits them (found the hard way). Ways keep the lighter output.
jobs.push(['q1rel_world.json', `[out:json][timeout:180][maxsize:536870912];
( relation["building"]["type"="multipolygon"](${w}); relation["building:part"]["type"="multipolygon"](${w}); );
out body geom qt;`]);
jobs.push(['q2_roads.json', `[out:json][timeout:180];
( way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)(_link)?$"](${w});
  way["railway"~"^(subway|light_rail|monorail|tram)$"](${w}); );
out tags geom qt;`]);
jobs.push(['q3_coast.json', `[out:json][timeout:120];
way["natural"="coastline"](${bb(BBOX.land)});
out geom qt;`]);
jobs.push(['q4_water.json', `[out:json][timeout:120];
( way["natural"="water"](${w}); );
out tags geom qt;
relation["natural"="water"](${w});
out body geom qt;`]);
jobs.push(['q5_cover.json', `[out:json][timeout:120];
( way["leisure"~"^(park|golf_course|pitch)$"](${w});
  way["landuse"~"^(grass|recreation_ground)$"](${w});
  way["natural"="beach"](${w}); );
out tags geom qt;`]);
jobs.push(['q6_landmarks.json', `[out:json][timeout:60];
nwr["name"~"Burj Khalifa|Burj Al Arab|Cayan Tower|Museum of the Future|Ain Dubai"](${w});
out center tags;`]);

let failed = 0;
for (const [file, q] of jobs) {
  try {
    await fetchCached(RAW + file, q, file, force);
  } catch (e) {
    failed++;
    console.error('FAILED ' + e.message);
  }
}
console.log(failed ? `${failed} job(s) failed; rerun to retry only those.` : 'All raw files present.');
process.exit(failed ? 1 : 0);
