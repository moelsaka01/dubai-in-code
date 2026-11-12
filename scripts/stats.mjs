// Prints the data report: sizes vs budget, height sources, tallest buildings, land stats. Exits 1 over the hard cap.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeTile, decodeLand } from '../src/shared/format.js';

const DIR = fileURLToPath(new URL('../public/data/', import.meta.url));
const REPORT = fileURLToPath(new URL('../data/build-report.json', import.meta.url));
if (!existsSync(DIR + 'manifest.json')) { console.error('No public/data/manifest.json. Run npm run data:build first.'); process.exit(1); }
const manifest = JSON.parse(readFileSync(DIR + 'manifest.json', 'utf8'));
const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : null;

const MB = (n) => (n / 1e6).toFixed(2) + ' MB';
const KB = (n) => (n / 1e3).toFixed(0) + ' KB';
const TARGET_RAW = 4.5e6, TARGET_GZ = 2.5e6, HARD_RAW = 8e6, HARD_TILE = 400e3;

let raw = 0, gz = 0;
const sizes = {};
const walk = (d, rel = '') => {
  for (const n of readdirSync(d)) {
    const p = d + n;
    if (statSync(p).isDirectory()) { walk(p + '/', rel + n + '/'); continue; }
    const buf = readFileSync(p);
    const g = gzipSync(buf).length;
    raw += buf.length; gz += g;
    const k = rel.startsWith('tiles') ? 'tiles' : n;
    sizes[k] = sizes[k] || [0, 0];
    sizes[k][0] += buf.length; sizes[k][1] += g;
  }
};
walk(DIR);

console.log(`Dubai in Code data report  (OSM ${manifest.osmTimestamp}, built ${manifest.builtAt})`);
console.log('\nSizes');
for (const [k, [r, g]] of Object.entries(sizes)) console.log(`  ${k.padEnd(16)} ${MB(r).padStart(9)} raw  ${MB(g).padStart(9)} gzip`);
console.log(`  ${'TOTAL'.padEnd(16)} ${MB(raw).padStart(9)} raw  ${MB(gz).padStart(9)} gzip   (target <= ${MB(TARGET_RAW)} / ${MB(TARGET_GZ)}, hard cap ${MB(HARD_RAW)} raw)`);
const biggest = manifest.tiles.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 3);
console.log('  largest tiles: ' + biggest.map((t) => `${t.id} ${KB(t.bytes)}`).join(', ') + `  (cap ${KB(HARD_TILE)})`);

const c = manifest.counts, h = manifest.heightSource, tot = h.tag + h.levels + h.override + h.estimate;
console.log(`\nBuildings ${c.buildings} (tier A ${c.tierA}, tier B ${c.tierB}) in ${manifest.tiles.length} tiles, ${c.roads} road pieces`);
const pct = (n) => ((100 * n) / tot).toFixed(1) + '%';
console.log(`Height source: tag ${h.tag} (${pct(h.tag)}), levels ${h.levels} (${pct(h.levels)}), override ${h.override} (${pct(h.override)}), estimate ${h.estimate} (${pct(h.estimate)})`);

// decode tiles for tall list and counts that need the binary
let est150 = 0, nTallTotal = 0;
const tallBin = [];
for (const t of manifest.tiles) {
  const d = decodeTile(readFileSync(`${DIR}tiles/${t.id}.bin`));
  nTallTotal += d.nTall;
  for (const b of d.buildings) {
    if (b.heightSrc === 3 && b.height >= 150) est150++;
    if (b.height >= 150) tallBin.push({ ...b, tile: t.id });
  }
}
console.log(`Buildings >= 40 m: ${nTallTotal}; >= 150 m: ${tallBin.length}; estimated and >= 150 m: ${est150}`);

if (report) {
  console.log('\n30 tallest buildings');
  console.log('  height  source    zone      area   id          name');
  for (const b of report.tall.slice(0, 30)) console.log(`  ${String(b.height.toFixed(0)).padStart(5)} m  ${b.src.padEnd(8)}  ${b.zone.padEnd(8)}  ${String(b.area).padStart(5)}  ${b.id.padEnd(10)}  ${b.name}${b.isPart ? ' (part)' : ''}`);
  console.log(`\nOverrides used: ${report.overridesUsed.length} of ${report.overridesDefined} defined${report.overridesUsed.length ? ' (' + report.overridesUsed.join(', ') + ')' : ''}`);
  console.log(`Parts: ${JSON.stringify(report.parts)}`);
  console.log(`SZR lines: ${report.szr.lines}, lengths ${report.szr.lengthsM.join(' / ')} m`);
  console.log(`Landmarks: ${Object.entries(report.landmarks).map(([k, v]) => `${k} dropped ${v.dropped}`).join(', ')}`);
}

const land = decodeLand(readFileSync(DIR + 'land.bin'));
const ringArea = (r) => { let a = 0; const n = r.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1]; return Math.abs(a / 2); };
let landArea = 0;
const kinds = [0, 0, 0];
for (const p of land) { kinds[p.kind]++; if (p.kind === 0) { landArea += ringArea(p.rings[0]); for (let i = 1; i < p.rings.length; i++) landArea -= ringArea(p.rings[i]); } }
console.log(`\nLand: ${kinds[0]} land polygons, ${kinds[1]} green, ${kinds[2]} beach; land area ${(landArea / 1e6).toFixed(0)} km² (padded box)`);
if (report) console.log(`  land fraction of world bbox ${(report.land.worldFraction * 100).toFixed(1)}%, Mall of the Emirates on land: ${report.land.mallOnLand}, Gulf corner on land: ${report.land.gulfOnLand}`);

const problems = [];
if (raw > HARD_RAW) problems.push(`total ${MB(raw)} exceeds the hard cap ${MB(HARD_RAW)}`);
for (const t of manifest.tiles) if (t.bytes > HARD_TILE) problems.push(`tile ${t.id} is ${KB(t.bytes)} > ${KB(HARD_TILE)}`);
if (raw > TARGET_RAW || gz > TARGET_GZ) console.log(`\nNOTE: over the target (${MB(TARGET_RAW)} raw / ${MB(TARGET_GZ)} gzip). Raise --tierb-area (120 -> 200 -> 300), then --tierb-tol (2 -> 3), then --drop-minor-outside.`);
if (problems.length) { console.error('\nFAIL: ' + problems.join('; ')); process.exit(1); }
console.log('\nBudget: OK');
