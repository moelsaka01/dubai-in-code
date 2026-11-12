// Task 2.8: roads + rail. Classify, simplify, split long ways; SZR stitching for traffic.json.
import { readFileSync } from 'node:fs';
import { simplifyLine } from './geom.mjs';
import { projectGeom } from './buildings.mjs';

export const ROAD_TOL_M = 1;
export const SPLIT_M = 1800;
const HIGHWAY = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, residential: 5, unclassified: 5, living_street: 5 };
const DEFAULT_LANES = [3, 3, 2, 2, 2, 1, 1, 1];

export function polyLength(p) {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return L;
}

/** Returns roads: { id, cls, lanes, flags, layer, ref, name, pts (flat metres) } */
export function loadRoads(path) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const roads = [];
  for (const e of j.elements) {
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue;
    const t = e.tags || {};
    let cls, link = false;
    if (t.railway) cls = 7;
    else if (t.highway) {
      link = t.highway.endsWith('_link');
      const base = t.highway.replace(/_link$/, '');
      cls = HIGHWAY[base];
      if (cls === undefined) continue;
      if (link) cls = 6;
    } else continue;
    // underground rail / tunnels are not drawn
    const tunnel = t.tunnel && t.tunnel !== 'no';
    const bridge = t.bridge && t.bridge !== 'no';
    if (cls === 7 && (tunnel || t.railway === 'subway')) continue;
    let lanes = parseInt(t.lanes, 10);
    if (!(lanes >= 1 && lanes <= 12)) lanes = DEFAULT_LANES[cls];
    const oneway = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' || cls === 0 && t.oneway !== 'no';
    const layer = Math.max(-5, Math.min(5, parseInt(t.layer, 10) || 0));
    roads.push({
      id: e.id, cls, lanes, layer, ref: t.ref || '', name: t.name || '',
      flags: (bridge ? 1 : 0) | (tunnel ? 2 : 0) | (oneway ? 4 : 0),
      pts: projectGeom(e.geometry),
    });
  }
  return { roads, timestamp: j.osm3s?.timestamp_osm_base || '' };
}

/** Simplify, split long ways. Returns pieces ready for tiling. */
export function prepareRoads(roads, { dropMinorOutside = null } = {}) {
  const out = [];
  for (const r of roads) {
    if (dropMinorOutside && r.cls === 5 && !dropMinorOutside(r)) continue;
    let pts = simplifyLine(r.pts, ROAD_TOL_M);
    if (pts.length < 4) continue;
    // split into pieces of <= SPLIT_M, sharing the joint vertex
    let cur = [pts[0], pts[1]], len = 0;
    for (let i = 2; i < pts.length; i += 2) {
      len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
      cur.push(pts[i], pts[i + 1]);
      if (len >= SPLIT_M && i + 2 < pts.length) {
        out.push({ ...r, pts: cur });
        cur = [pts[i], pts[i + 1]];
        len = 0;
      }
    }
    if (cur.length >= 4) out.push({ ...r, pts: cur });
  }
  return out;
}

const pk = (p, i) => `${Math.round(p[i] * 10)},${Math.round(p[i + 1] * 10)}`;

/** Chain oneway ways head-to-tail (directed). Returns array of flat polylines. */
function chainDirected(ways) {
  const byStart = new Map();
  for (const w of ways) {
    const k = pk(w.pts, 0);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(w);
  }
  const hasPred = new Set();
  for (const w of ways) hasPred.add(pk(w.pts, w.pts.length - 2));
  const used = new Set();
  const chains = [];
  const starts = ways.filter((w) => !hasPred.has(pk(w.pts, 0)));
  const order = starts.concat(ways);
  for (const s of order) {
    if (used.has(s)) continue;
    used.add(s);
    let pts = s.pts.slice();
    for (;;) {
      const cands = (byStart.get(pk(pts, pts.length - 2)) || []).filter((c) => !used.has(c));
      if (!cands.length) break;
      cands.sort((a, b) => polyLength(b.pts) - polyLength(a.pts));
      const n = cands[0];
      used.add(n);
      pts = pts.concat(n.pts.slice(2));
    }
    chains.push(pts);
  }
  return chains;
}

/** Join chains that end near where another starts (gaps up to maxGap m). */
function joinGaps(chains, maxGap) {
  chains = chains.slice();
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < chains.length; i++) {
      const a = chains[i];
      const ex = a[a.length - 2], ey = a[a.length - 1];
      let bj = -1, bd = maxGap;
      for (let j = 0; j < chains.length; j++) {
        if (j === i) continue;
        const d = Math.hypot(chains[j][0] - ex, chains[j][1] - ey);
        if (d < bd) { bd = d; bj = j; }
      }
      if (bj >= 0) {
        const b = chains[bj];
        chains[i] = a.concat(b);
        chains.splice(bj, 1);
        merged = true;
        break outer;
      }
    }
  }
  return chains;
}

/**
 * SZR: motorway ways with ref containing "E 11", chained per direction. Returns { lines: [A, B] (longest two), all, ways }.
 * Direction A = heading towards increasing east+north (towards Abu Dhabi is south-west, so A is Dubai->NE), B opposite.
 */
export function extractSzr(roads) {
  const ways = roads.filter((r) => r.cls === 0 && /\bE\s?11\b/.test(r.ref));
  let chains = joinGaps(chainDirected(ways), 250).filter((c) => polyLength(c) > 500);
  chains.sort((a, b) => polyLength(b) - polyLength(a));
  const dirOf = (c) => (c[c.length - 2] - c[0]) + (c[c.length - 1] - c[1]);
  const ne = chains.filter((c) => dirOf(c) > 0), sw = chains.filter((c) => dirOf(c) <= 0);
  const lines = [ne[0], sw[0]].filter(Boolean);
  return { lines, all: chains, wayCount: ways.length };
}

/** Other motorways (not E 11) as long polylines for traffic: chained and thinned. */
export function otherMotorways(roads) {
  const ways = roads.filter((r) => r.cls === 0 && !/\bE\s?11\b/.test(r.ref) && r.flags & 4);
  return joinGaps(chainDirected(ways), 100).filter((c) => polyLength(c) > 1500).sort((a, b) => polyLength(b) - polyLength(a)).slice(0, 12);
}
