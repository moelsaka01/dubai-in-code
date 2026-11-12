// Task 2.6: building:part resolution (PLAN.md section 2, step 3). Tier A only.
// If parts whose centroids lie inside an outline cover >= 50% of its area, drop the outline and keep the parts.
// Otherwise drop the parts. Tier B drops all parts. Parts not inside any outline are kept in Tier A.
import { pointInPoly } from './geom.mjs';

const CELL = 200;
const cellKey = (x, y) => Math.floor(x / CELL) * 100000 + Math.floor(y / CELL);

export function resolveParts(buildings, { enabled = true } = {}) {
  const outlines = buildings.filter((b) => !b.isPart);
  const parts = buildings.filter((b) => b.isPart);
  const stats = { outlines: outlines.length, parts: parts.length, outlinesReplaced: 0, partsKept: 0, partsDropped: 0 };
  if (!enabled) {
    stats.partsDropped = parts.length;
    return { buildings: outlines, stats };
  }
  // index parts by centroid cell
  const idx = new Map();
  for (const p of parts) {
    if (!p.tierA) { stats.partsDropped++; p.drop = true; continue; }
    const k = cellKey(p.cx, p.cy);
    let l = idx.get(k);
    if (!l) idx.set(k, (l = []));
    l.push(p);
  }
  const replaced = new Set();
  for (const o of outlines) {
    if (!o.tierA) continue;
    const r = o.rings[0];
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) {
      bx0 = Math.min(bx0, r[i]); bx1 = Math.max(bx1, r[i]);
      by0 = Math.min(by0, r[i + 1]); by1 = Math.max(by1, r[i + 1]);
    }
    const inside = [];
    for (let cx = Math.floor(bx0 / CELL); cx <= Math.floor(bx1 / CELL); cx++) {
      for (let cy = Math.floor(by0 / CELL); cy <= Math.floor(by1 / CELL); cy++) {
        for (const p of idx.get(cx * 100000 + cy) || []) {
          if (pointInPoly(p.cx, p.cy, o.rings)) inside.push(p);
        }
      }
    }
    if (!inside.length) continue;
    const covered = Math.min(o.area, inside.reduce((s, p) => s + p.area, 0));
    if (covered >= 0.5 * o.area) {
      replaced.add(o);
      o.partChildren = inside;
      for (const p of inside) p.parent = o;
    } else {
      for (const p of inside) p.drop = true;
    }
  }
  const out = [];
  for (const o of outlines) {
    if (replaced.has(o)) { stats.outlinesReplaced++; continue; }
    out.push(o);
  }
  for (const p of parts) {
    if (p.drop) { if (p.tierA) stats.partsDropped++; continue; }
    // inherit name/building type from the outline it replaced (heights are not inherited)
    if (p.parent) for (const k of ['name', 'building']) {
      if (p.tags[k] === undefined && p.parent.tags[k] !== undefined) p.tags = { ...p.tags, [k]: p.parent.tags[k] };
    }
    stats.partsKept++;
    out.push(p);
  }
  return { buildings: out, stats };
}
