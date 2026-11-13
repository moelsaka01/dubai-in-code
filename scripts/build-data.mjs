// Builds public/data/ from data/raw/. Usage: node scripts/build-data.mjs [--no-parts] [--tierb-area N] [--tierb-tol M] [--drop-minor-outside]
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ORIGIN, TILE_SIZE, GRID_MIN, GRID_N, M_PER_DEG_LAT, M_PER_DEG_LON, LANDMARKS, TIER_B_MIN_AREA_M2, project, tileOf } from '../src/shared/config.js';
import { encodeTile, encodeLand, TILE_VERSION } from '../src/shared/format.js';
import { simplifyRing, minAreaRect, distToPolyline } from './lib/geom.mjs';
import { loadBuildings, assignZones, clearLandmarks, readRaw, ZONE_BOXES } from './lib/buildings.mjs';
import { resolveParts } from './lib/parts.mjs';
import { applyHeights, loadOverrides } from './lib/heights.mjs';
import { loadRoads, prepareRoads, extractSzr, otherMotorways } from './lib/roads.mjs';
import { loadCoast, loadWater, loadCover, buildLand, polysArea, landAreaInWorld, pointOnLand } from './lib/coast.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const flag = (n) => process.argv.includes(n);
const TIERB_AREA = arg('--tierb-area', TIER_B_MIN_AREA_M2);
const TIER_A_TOL = 0.5, TIER_B_TOL = arg('--tierb-tol', 2);
const RAW = fileURLToPath(new URL('../data/raw/', import.meta.url));
const OUT = fileURLToPath(new URL('../public/data/', import.meta.url));
const REPORT = fileURLToPath(new URL('../data/build-report.json', import.meta.url));
const t0 = Date.now();
const log = (...a) => console.log(...a);

// ---- roads first (SZR defines Tier A) ----
log('roads ...');
const { roads: rawRoads, timestamp: roadsTs } = loadRoads(RAW + 'q2_roads.json');
const szr = extractSzr(rawRoads);
log(`  ${rawRoads.length} ways, SZR: ${szr.wayCount} ways -> ${szr.all.length} chains, using ${szr.lines.length} lines`);
if (szr.lines.length < 2) log('  WARNING: fewer than 2 SZR carriageway lines found');

// ---- buildings ----
log('buildings ...');
const loaded = loadBuildings(RAW);
let blds = loaded.buildings;
log(`  ${loaded.stats.elements} elements, ${blds.length} polygons (dupes ${loaded.stats.dupes}, relation-member ways skipped ${loaded.stats.memberWays}, degenerate ${loaded.stats.degenerate}, <12 m² ${loaded.stats.tiny})`);
assignZones(blds, szr.lines);
const lm = clearLandmarks(blds);
blds = lm.buildings;
for (const [k, v] of Object.entries(lm.info)) log(`  landmark ${k}: dropped ${v.dropped.length}, footprint ${v.footprint ? v.footprint.id + ' ' + v.footprint.area.toFixed(0) + ' m²' : 'none'}`);

// tier B filter (footprint and parts), then parts resolution
const beforeB = blds.length;
blds = blds.filter((b) => b.tierA || (!b.isPart && b.area >= TIERB_AREA));
log(`  tier B filter (>= ${TIERB_AREA} m², no parts): ${beforeB} -> ${blds.length}`);
const parts = resolveParts(blds, { enabled: !flag('--no-parts') });
blds = parts.buildings;
log(`  parts: ${JSON.stringify(parts.stats)}`);

const overrides = loadOverrides(fileURLToPath(new URL('../data/overrides.json', import.meta.url)));
applyHeights(blds, overrides);

// ---- simplify ----
const fitRing = (r, tol) => {
  let t = tol, s = simplifyRing(r, t);
  while (s && s.length / 2 > 255) { t *= 1.6; s = simplifyRing(s, t); }
  return s;
};
const nonEmpty = [];
for (const b of blds) {
  const tol = b.tierA ? TIER_A_TOL : TIER_B_TOL;
  const outer = fitRing(b.rings[0], tol);
  if (!outer) continue;
  const holes = b.rings.slice(1).map((h) => fitRing(h, tol)).filter(Boolean);
  b.rings = [outer, ...holes].slice(0, 255);
  nonEmpty.push(b);
}
blds = nonEmpty;
log(`  after simplify: ${blds.length} buildings`);

// ---- tiling ----
log('tiling ...');
const tiles = new Map();
const tileAt = (x, y) => {
  const [tx, ty] = tileOf(x, y);
  if (tx < 0 || ty < 0 || tx >= GRID_N || ty >= GRID_N) return null;
  const id = tx + '_' + ty;
  let t = tiles.get(id);
  if (!t) tiles.set(id, (t = { tx, ty, buildings: [], roads: [] }));
  return t;
};
let outside = 0;
for (const b of blds) {
  const t = tileAt(b.cx, b.cy);
  if (!t) { outside++; continue; }
  b.tile = t;
  t.buildings.push(b);
}
const roadPieces = prepareRoads(rawRoads, {
  dropMinorOutside: flag('--drop-minor-outside') ? (r) => Object.values(ZONE_BOXES).some((z) => r.pts[0] >= z[0] && r.pts[0] <= z[2] && r.pts[1] >= z[1] && r.pts[1] <= z[3]) || szr.lines.some((l) => distToPolyline(r.pts[0], r.pts[1], l) < 600) : null,
});
for (const r of roadPieces) {
  const t = tileAt(r.pts[0], r.pts[1]);
  if (!t) { outside++; continue; }
  t.roads.push(r);
}
if (outside) log(`  ${outside} features outside the grid skipped`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT + 'tiles/', { recursive: true });
const manifestTiles = [];
const srcCount = [0, 0, 0, 0];
const tierCount = { A: 0, B: 0 };
let totalBytes = 0, totalB = 0, totalR = 0;
for (const t of tiles.values()) {
  const ox = GRID_MIN + t.tx * TILE_SIZE, oy = GRID_MIN + t.ty * TILE_SIZE;
  t.buildings.sort((a, b) => b.height - a.height);
  const eb = t.buildings.map((b) => {
    srcCount[b.heightSrc]++;
    b.tierA ? tierCount.A++ : tierCount.B++;
    return {
      height: b.height, minHeight: b.minHeight, heightSrc: b.heightSrc, kind: b.kind, tierB: !b.tierA, isPart: b.isPart, seed: b.seed,
      rings: b.rings.map((r) => r.map((v, i) => v - (i % 2 ? oy : ox))),
    };
  });
  const er = t.roads.map((r) => ({ cls: r.cls, lanes: r.lanes, flags: r.flags, layer: r.layer, pts: r.pts.map((v, i) => v - (i % 2 ? oy : ox)) }));
  const bin = encodeTile({ tx: t.tx, ty: t.ty, buildings: eb, roads: er });
  writeFileSync(`${OUT}tiles/${t.tx}_${t.ty}.bin`, bin);
  manifestTiles.push({
    id: `${t.tx}_${t.ty}`, tx: t.tx, ty: t.ty, bytes: bin.length, nBuildings: eb.length, nRoads: er.length,
    maxHeight: eb.length ? Math.round(eb[0].height) : 0,
  });
  totalBytes += bin.length; totalB += eb.length; totalR += er.length;
}
manifestTiles.sort((a, b) => a.ty - b.ty || a.tx - b.tx);
log(`  ${manifestTiles.length} tiles, ${totalB} buildings, ${totalR} road pieces, ${(totalBytes / 1e6).toFixed(2)} MB`);

// ---- land ----
log('land ...');
const coast = loadCoast(RAW);
const water = loadWater(RAW);
const cover = loadCover(RAW);
const land = buildLand(coast.chains, water, log);
const lw = landAreaInWorld(land.result);
const landFrac = lw.area / lw.worldArea;
const mall = pointOnLand(land.result, 25.118, 55.2), gulf = pointOnLand(land.result, 25.225, 55.1);
log(`  ${land.polys.length} land polygons, ${water.length} water polygons subtracted, ${cover.length} green/beach polygons`);
log(`  land fraction of world bbox: ${(landFrac * 100).toFixed(1)}% (expect ~55%); Mall of the Emirates on land: ${mall}; Gulf NW corner on land: ${gulf}`);
const landPolys = land.polys.concat(cover);
const landBin = encodeLand(landPolys);
writeFileSync(OUT + 'land.bin', landBin);

// ---- traffic ----
const r1 = (v) => Math.round(v * 10) / 10;
const lineOut = (l) => Array.from(l, r1);
const traffic = { version: 1, szr: szr.lines.map(lineOut), motorways: otherMotorways(rawRoads).map(lineOut) };
writeFileSync(OUT + 'traffic.json', JSON.stringify(traffic));

// ---- landmarks ----
const landmarks = {};
for (const [k, l] of Object.entries(LANDMARKS)) {
  const [x, y] = project(l.lat, l.lon);
  const fp = lm.info[k].footprint;
  let rect = null;
  if (fp) { const r = minAreaRect(fp.ring); rect = { angle: +r.angle.toFixed(4), length: +r.length.toFixed(1), width: +r.width.toFixed(1), cx: +r.cx.toFixed(1), cy: +r.cy.toFixed(1) }; }
  landmarks[k] = { name: l.name, lat: l.lat, lon: l.lon, x: r1(x), north: r1(y), height: l.height, clear: l.clear, osm: l.osm, footprintId: fp?.id ?? null, rotation: rect?.angle ?? 0, footprint: rect, dropped: lm.info[k].dropped };
}
writeFileSync(OUT + 'landmarks.json', JSON.stringify({ version: 1, landmarks }));

// ---- manifest ----
const heightSource = { tag: srcCount[0], levels: srcCount[1], override: srcCount[2], estimate: srcCount[3] };
const osmTs = [loaded.timestamp, roadsTs].filter(Boolean).sort().pop() || '';
const manifest = {
  version: 1, tileVersion: TILE_VERSION, origin: ORIGIN, mPerDegLat: M_PER_DEG_LAT, mPerDegLon: M_PER_DEG_LON,
  tileSize: TILE_SIZE, gridMin: GRID_MIN, gridN: GRID_N, osmTimestamp: osmTs, builtAt: new Date().toISOString(),
  counts: { buildings: totalB, tierA: tierCount.A, tierB: tierCount.B, roads: totalR, landPolys: landPolys.length },
  heightSource, tiles: manifestTiles,
};
writeFileSync(OUT + 'manifest.json', JSON.stringify(manifest));

// ---- build report (not shipped; read by stats.mjs) ----
const unmatched = [...overrides.byName.keys()].length;
const tall = blds.slice().sort((a, b) => b.height - a.height).slice(0, 60).map((b) => ({
  id: b.id, name: b.tags.name || '', height: +b.height.toFixed(1), src: ['tag', 'levels', 'override', 'estimate'][b.heightSrc], zone: b.zone, area: Math.round(b.area), isPart: b.isPart,
}));
const estimatedTall = blds.filter((b) => b.heightSrc === 3 && b.height >= 150).length;
writeFileSync(REPORT, JSON.stringify({
  builtAt: manifest.builtAt, flags: process.argv.slice(2), tall, estimatedTall,
  overridesUsed: [...overrides.used], overridesDefined: unmatched, parts: parts.stats,
  land: { polys: land.polys.length, areaM2: polysArea(land.polys), worldFraction: landFrac, mallOnLand: mall, gulfOnLand: gulf },
  szr: { lines: szr.lines.length, lengthsM: szr.lines.map((l) => { let L = 0; for (let i = 2; i < l.length; i += 2) L += Math.hypot(l[i] - l[i - 2], l[i + 1] - l[i - 1]); return Math.round(L); }) },
  landmarks: Object.fromEntries(Object.entries(landmarks).map(([k, v]) => [k, { dropped: v.dropped.length, footprintId: v.footprintId, rotation: v.rotation }])),
}, null, 1));
// ---- bridge heights, from the tiles and traffic.json just written ----
const { buildBridges } = await import('./build-bridges.mjs');
log(`bridges.json: ${JSON.stringify(buildBridges(OUT))}`);
log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
