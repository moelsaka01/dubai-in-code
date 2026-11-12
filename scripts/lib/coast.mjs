// Task 2.9: coastline stitching, closing against the land bbox, union, inland water subtraction, green/beach polygons.
import { readFileSync } from 'node:fs';
import pc from 'polygon-clipping';
import { BBOX, project } from '../../src/shared/config.js';
import { area, openRing, orient, signedArea, simplifyLine, simplifyRing, stitch, pointInRing } from './geom.mjs';
import { projectGeom, relationRings } from './buildings.mjs';

const key = (g) => `${g.lat},${g.lon}`;
const projBox = (b) => [...project(b[0], b[1]), ...project(b[2], b[3])];
export const LAND_BOX = projBox(BBOX.land);
const WORLD_PAD = (() => { const b = projBox(BBOX.world); return [b[0] - 300, b[1] - 300, b[2] + 300, b[3] + 300]; })();
const TOL_IN = 1, TOL_OUT = 8;

/** Simplify with 1 m inside the (padded) world box and 8 m outside. pts open polyline. */
function simplifyAdaptive(pts) {
  const n = pts.length / 2;
  const inside = (i) => pts[i * 2] >= WORLD_PAD[0] && pts[i * 2] <= WORLD_PAD[2] && pts[i * 2 + 1] >= WORLD_PAD[1] && pts[i * 2 + 1] <= WORLD_PAD[3];
  const out = [];
  let s = 0;
  while (s < n - 1) {
    const f = inside(s);
    let e = s + 1;
    while (e < n - 1 && inside(e) === f) e++;
    const run = simplifyLine(pts.slice(s * 2, (e + 1) * 2), f ? TOL_IN : TOL_OUT);
    if (out.length) run.splice(0, 2);
    for (const v of run) out.push(v);
    s = e;
  }
  return out;
}

// ---- clipping a polyline to an axis-aligned rect ----
function clipSegment(x0, y0, x1, y1, box) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  for (const [p, q] of [[-dx, x0 - box[0]], [dx, box[2] - x0], [-dy, y0 - box[1]], [dy, box[3] - y0]]) {
    if (p === 0) { if (q < 0) return null; }
    else {
      const r = q / p;
      if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return [t0, t1];
}

/** Perimeter parameter, counter-clockwise from the bottom-left corner. */
function perim(x, y, box) {
  const W = box[2] - box[0], H = box[3] - box[1];
  const e = 1e-6;
  if (Math.abs(y - box[1]) < e) return x - box[0];
  if (Math.abs(x - box[2]) < e) return W + (y - box[1]);
  if (Math.abs(y - box[3]) < e) return W + H + (box[2] - x);
  return 2 * W + H + (box[3] - y);
}

function clipPolyline(pts, box) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const [x0, y0, x1, y1] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]];
    const c = clipSegment(x0, y0, x1, y1, box);
    if (!c) { if (cur) { pieces.push(cur); cur = null; } continue; }
    const [t0, t1] = c;
    const sx = x0 + (x1 - x0) * t0, sy = y0 + (y1 - y0) * t0, ex = x0 + (x1 - x0) * t1, ey = y0 + (y1 - y0) * t1;
    if (!cur) cur = [sx, sy]; else if (t0 > 0) { pieces.push(cur); cur = [sx, sy]; }
    cur.push(ex, ey);
    if (t1 < 1) { pieces.push(cur); cur = null; }
  }
  if (cur) pieces.push(cur);
  return pieces.filter((p) => p.length >= 4);
}

/** Build land rings from open coast pieces: follow each piece, then the box edge CCW to the next piece start. */
function closeAgainstBox(pieces, box) {
  const W = box[2] - box[0], H = box[3] - box[1], P = 2 * (W + H);
  const corners = [[box[0], box[1], 0], [box[2], box[1], W], [box[2], box[3], W + H], [box[0], box[3], 2 * W + H]];
  const info = pieces.map((p) => ({ p, s: perim(p[0], p[1], box), e: perim(p[p.length - 2], p[p.length - 1], box) }));
  const rings = [];
  const used = new Set();
  for (let i0 = 0; i0 < info.length; i0++) {
    if (used.has(i0)) continue;
    let ring = [], i = i0, guard = 0;
    for (;;) {
      used.add(i);
      for (const v of info[i].p) ring.push(v);
      // find next piece start going CCW from this end
      let best = -1, bd = Infinity;
      for (let j = 0; j < info.length; j++) {
        let d = info[j].s - info[i].e;
        if (d < -1e-6) d += P;
        if (d < bd) { bd = d; best = j; }
      }
      const eP = info[i].e, sP = info[best].s;
      const span = ((sP - eP) % P + P) % P;
      const between = corners.map(([cx, cy, cp]) => [cx, cy, ((cp - eP) % P + P) % P]).filter((c) => c[2] > 1e-6 && c[2] < span - 1e-6).sort((a, b) => a[2] - b[2]);
      for (const [cx, cy] of between) ring.push(cx, cy);
      i = best;
      if (i === i0 || used.has(i) || ++guard > info.length + 2) break;
    }
    rings.push(ring);
  }
  return rings;
}

const toPC = (rings) => rings.map((r) => {
  const c = Array.from({ length: r.length / 2 }, (_, i) => [r[i * 2], r[i * 2 + 1]]);
  c.push(c[0].slice());
  return c;
});
const fromPCRing = (r) => {
  const o = [];
  for (let i = 0; i < r.length - 1; i++) o.push(r[i][0], r[i][1]);
  return o;
};

export function loadCoast(dir) {
  const j = JSON.parse(readFileSync(dir + 'q3_coast.json', 'utf8'));
  const segs = [];
  for (const e of j.elements) {
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue;
    segs.push({ pts: projectGeom(e.geometry), a: key(e.geometry[0]), b: key(e.geometry[e.geometry.length - 1]) });
  }
  const chains = stitch(segs);
  return { chains, ways: segs.length };
}

export function loadWater(dir) {
  const j = JSON.parse(readFileSync(dir + 'q4_water.json', 'utf8'));
  const polys = [];
  for (const e of j.elements) {
    if (e.type === 'way' && e.geometry && e.geometry.length > 3) {
      const r = openRing(projectGeom(e.geometry));
      if (r.length >= 6 && area(r) >= 100) polys.push({ id: 'w' + e.id, rings: [orient(r, true)] });
    } else if (e.type === 'relation') {
      const { outers, inners } = relationRings(e);
      for (const o of outers) {
        if (area(o) < 100) continue;
        const holes = inners.filter((h) => pointInRing(h[0], h[1], o)).map((h) => orient(h, false));
        polys.push({ id: 'r' + e.id, rings: [orient(o, true), ...holes] });
      }
    }
  }
  return polys;
}

export function loadCover(dir) {
  const j = JSON.parse(readFileSync(dir + 'q5_cover.json', 'utf8'));
  const polys = [];
  for (const e of j.elements) {
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 4) continue;
    const t = e.tags || {};
    const kind = t.natural === 'beach' ? 2 : 1;
    let r = openRing(projectGeom(e.geometry));
    if (r.length < 6 || area(r) < 300) continue;
    r = simplifyRing(r, 1);
    if (!r) continue;
    polys.push({ kind, rings: [orient(r, true)] });
  }
  return polys;
}

/**
 * Build land polygons. Returns { polys: [{kind:0, rings}], log, stats }.
 * Each polygon: rings[0] outer CCW, rest holes CW (flat open rings, metres).
 */
export function buildLand(chains, waterPolys, log = console.log) {
  const islands = [], lagoons = [], open = [];
  for (const c of chains) {
    const pts = simplifyAdaptive(c.pts);
    if (c.closed) {
      const r = openRing(pts);
      if (r.length < 6) continue;
      (signedArea(r) > 0 ? islands : lagoons).push(r);
    } else open.push(pts);
  }
  const pieces = [];
  for (const o of open) for (const p of clipPolyline(o, LAND_BOX)) pieces.push(p);
  const boxRings = pieces.length ? closeAgainstBox(pieces, LAND_BOX) : [];
  log(`coast: ${chains.length} chains -> ${islands.length} islands, ${lagoons.length} reversed (water) rings, ${open.length} open chains, ${pieces.length} clipped pieces, ${boxRings.length} box-closed rings`);

  const landRings = [...islands, ...boxRings.map((r) => orient(openRing(r), true))];
  let land = [];
  for (const r of landRings) {
    try { land.push(pc.union(toPC([r]))); } catch (e) { log('  skip land ring: ' + e.message); }
  }
  let landU;
  try { landU = pc.union(...land.map((m) => m)); } catch (e) {
    log('  union failed (' + e.message + '), trying one by one');
    landU = [];
    for (const m of land) { try { landU = pc.union(landU, m); } catch (e2) { log('  skip: ' + e2.message); } }
  }
  // water to subtract: inland water + reversed (lagoon) coast rings
  const water = [];
  let skipped = 0;
  const wlist = waterPolys.map((w) => toPC(w.rings)).concat(lagoons.map((r) => toPC([orient(r, true)])));
  for (const w of wlist) {
    try { water.push(pc.union(w)); } catch { skipped++; }
  }
  let waterU = [];
  try { waterU = pc.union(...water); } catch (e) {
    log('  water union failed (' + e.message + '), unioning incrementally');
    for (const w of water) { try { waterU = pc.union(waterU, w); } catch { skipped++; } }
  }
  let result = landU;
  try { if (waterU.length) result = pc.difference(landU, waterU); } catch (e) {
    log('  water subtraction failed (' + e.message + '); trying per-polygon');
    result = landU;
    for (const w of water) { try { result = pc.difference(result, w); } catch { skipped++; } }
  }
  if (skipped) log(`  skipped ${skipped} bad water polygons`);

  const polys = [];
  for (const poly of result) {
    const rings = poly.map(fromPCRing).filter((r) => r.length >= 6);
    if (!rings.length) continue;
    const outer = orient(rings[0], true);
    if (area(outer) < 20) continue;
    let holes = rings.slice(1).filter((h) => area(h) >= 20).map((h) => orient(h, false));
    if (holes.length > 254) { holes.sort((a, b) => area(b) - area(a)); log(`  polygon had ${holes.length} holes, keeping 254`); holes = holes.slice(0, 254); }
    polys.push({ kind: 0, rings: [outer, ...holes] });
  }
  return { polys, result };
}

export function polysArea(polys) {
  let a = 0;
  for (const p of polys) { a += area(p.rings[0]); for (let i = 1; i < p.rings.length; i++) a -= area(p.rings[i]); }
  return a;
}

/** Land area (m^2) inside the world bbox. */
export function landAreaInWorld(result) {
  const b = projBox(BBOX.world);
  const rect = [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]];
  const inter = pc.intersection(result, [rect]);
  let a = 0;
  for (const poly of inter) {
    poly.forEach((r, i) => { const ar = area(fromPCRing(r)); a += i === 0 ? ar : -ar; });
  }
  return { area: a, worldArea: (b[2] - b[0]) * (b[3] - b[1]) };
}

export function pointOnLand(result, lat, lon) {
  const [x, y] = project(lat, lon);
  for (const poly of result) {
    if (!pointInRing(x, y, fromPCRing(poly[0]))) continue;
    if (poly.slice(1).some((h) => pointInRing(x, y, fromPCRing(h)))) continue;
    return true;
  }
  return false;
}
