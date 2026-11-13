// Writes public/data/bridges.json from the tiles and traffic.json already in public/data:
//   nodes:   for every point where two bridge ways meet, [east, north, distance to ground, reach, deck height]
//   traffic: for each polyline of traffic.json (szr first, then motorways), the height of the motorway under
//            it, sampled every STEP metres and stored as runs [first sample, h, h, ...] where it is off the ground
// See src/shared/bridges.js for what the numbers mean. Run by `npm run data:build`, or alone: `npm run data:bridges`.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodeTile } from '../src/shared/format.js';
import { TILE_SIZE, GRID_MIN } from '../src/shared/config.js';
import { bridgeTable, isRaised, nodeKey, liftOf, deckHeight } from '../src/shared/bridges.js';

export const TRAFFIC_STEP = 8;

export function buildBridges(dataDir) {
  const ways = [];
  for (const f of readdirSync(path.join(dataDir, 'tiles'))) {
    const tile = decodeTile(readFileSync(path.join(dataDir, 'tiles', f)));
    const e0 = GRID_MIN + tile.tx * TILE_SIZE, n0 = GRID_MIN + tile.ty * TILE_SIZE;
    for (const r of tile.roads) {
      if (!isRaised(r) || r.pts.length < 4) continue;
      const pts = new Float64Array(r.pts.length);
      for (let i = 0; i < pts.length; i += 2) { pts[i] = e0 + r.pts[i]; pts[i + 1] = n0 + r.pts[i + 1]; }
      ways.push({ cls: r.cls, layer: r.layer, pts });
    }
  }
  const { nodes } = bridgeTable(ways);

  // Height of every motorway bridge segment, in a grid for the lookup below.
  const CELL = 64, grid = new Map();
  for (const w of ways) {
    if (w.cls !== 0) continue;
    const p = w.pts, n = p.length;
    let total = 0;
    for (let i = 2; i < n; i += 2) total += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    const a = nodes.get(nodeKey(p[0], p[1])), b = nodes.get(nodeKey(p[n - 2], p[n - 1]));
    const ref = a || b;
    const reach = ref ? ref[1] : total / 2, top = ref ? ref[2] : deckHeight(w.cls, w.layer);
    let s = 0;
    for (let i = 0; i < n - 2; i += 2) {
      const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      const seg = { ax: p[i], ay: p[i + 1], bx: p[i + 2], by: p[i + 3], s, len, total, dS: a ? a[0] : 0, dE: b ? b[0] : 0, reach, top };
      const x0 = Math.floor(Math.min(seg.ax, seg.bx) / CELL), x1 = Math.floor(Math.max(seg.ax, seg.bx) / CELL);
      const y0 = Math.floor(Math.min(seg.ay, seg.by) / CELL), y1 = Math.floor(Math.max(seg.ay, seg.by) / CELL);
      for (let x = x0 - 1; x <= x1 + 1; x++) for (let y = y0 - 1; y <= y1 + 1; y++) {
        const k = `${x}_${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(seg);
      }
      s += len;
    }
  }
  const heightAt = (x, y) => {
    const list = grid.get(`${Math.floor(x / CELL)}_${Math.floor(y / CELL)}`);
    if (!list) return 0;
    let best = 6, h = 0; // within 6 m of a bridge centre line
    for (const g of list) {
      const t = Math.min(1, Math.max(0, ((x - g.ax) * (g.bx - g.ax) + (y - g.ay) * (g.by - g.ay)) / (g.len * g.len || 1)));
      const d = Math.hypot(x - (g.ax + (g.bx - g.ax) * t), y - (g.ay + (g.by - g.ay) * t));
      if (d < best) { best = d; h = liftOf(g.s + t * g.len, g.total, g.dS, g.dE, g.reach, g.top); }
    }
    return h;
  };

  const traffic = JSON.parse(readFileSync(path.join(dataDir, 'traffic.json'), 'utf8'));
  const lines = [];
  for (const pts of [...traffic.szr, ...traffic.motorways]) {
    const runs = [];
    let run = null, k = 0, carry = 0;
    for (let i = 0; i < pts.length - 2; i += 2) {
      const len = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
      let s = carry;
      for (; s <= len; s += TRAFFIC_STEP, k++) {
        const f = len ? s / len : 0;
        const h = heightAt(pts[i] + (pts[i + 2] - pts[i]) * f, pts[i + 1] + (pts[i + 3] - pts[i + 1]) * f);
        if (h > 0.05) { if (!run) runs.push(run = [k]); run.push(Math.round(h * 10) / 10); } else run = null;
      }
      carry = s - len;
    }
    lines.push(runs);
  }

  const flat = [];
  for (const [key, v] of nodes) { const [e, n] = key.split('_').map(Number); flat.push(e, n, v[0], v[1], v[2]); }
  writeFileSync(path.join(dataDir, 'bridges.json'), JSON.stringify({ version: 1, step: TRAFFIC_STEP, nodes: flat, traffic: lines }));
  const byClass = {};
  for (const w of ways) byClass[w.cls] = (byClass[w.cls] || 0) + 1;
  return { ways: ways.length, byClass, nodes: nodes.size, trafficRuns: lines.map((l) => l.length) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/data');
  console.log('bridges.json:', JSON.stringify(buildBridges(dir)));
}
