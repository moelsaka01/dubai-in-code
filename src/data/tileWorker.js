// Tile worker: fetch + decode a tile, triangulate roofs, build walls and road ribbons, and hand typed arrays back.
// Geometry is tile-local: x = east, y = up, z = -north, relative to the tile's south-west corner.
// Flipping north to -z is handled here once: plan-CCW rings give outward walls and upward roofs (see wall()).
import earcut from 'earcut';
import { decodeTile, decodeLand } from '../shared/format.js';
import { TILE_SIZE, GRID_MIN } from '../shared/config.js';
import { buildBuildings } from './buildingMesh.js';

const LAND_Y = 1.5; // top of the land slab
const COVER_Y = 1.55; // parks and beaches
const ROAD_Y = 1.6;
const BAY = 3.1; // target window bay width in metres
const LIGHT_SPACING = 40;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${m.url}`);
    const buf = await res.arrayBuffer();
    if (m.type === 'tile') {
      const out = buildTile(decodeTile(buf));
      self.postMessage({ type: 'tile', id: m.id, ...out.data }, out.transfer);
    } else {
      const out = buildLand(decodeLand(buf));
      self.postMessage({ type: 'land', id: m.id, ...out.data }, out.transfer);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message ? err.message : err) });
  }
};

// ---------- shared helpers ----------

function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
  }
  return a / 2;
}

/** Drop a repeated closing point and force the winding: outer rings CCW in plan, holes CW. Returns null if degenerate. */
function normRing(r, isHole) {
  let n = r.length / 2;
  if (n > 1 && r[0] === r[2 * n - 2] && r[1] === r[2 * n - 1]) n--;
  if (n < 3) return null;
  const out = new Float32Array(n * 2);
  const a = ringArea(r.subarray ? r.subarray(0, n * 2) : r.slice(0, n * 2));
  if (Math.abs(a) < 0.5) return null;
  const keep = isHole ? a < 0 : a > 0;
  for (let i = 0; i < n; i++) {
    const s = keep ? i : n - 1 - i;
    out[2 * i] = r[2 * s];
    out[2 * i + 1] = r[2 * s + 1];
  }
  return out;
}

/** Rings (plan coords) -> { flat: [x, z, ...] scene coords, tris } with every triangle wound to face +y. */
function triangulate(rings) {
  let n = 0;
  for (const r of rings) n += r.length / 2;
  const flat = new Float32Array(n * 2);
  const holes = [];
  let o = 0;
  for (let k = 0; k < rings.length; k++) {
    const r = rings[k];
    if (k > 0) holes.push(o / 2);
    for (let i = 0; i < r.length; i += 2) {
      flat[o++] = r[i];
      flat[o++] = -r[i + 1];
    }
  }
  const tris = earcut(flat, holes, 2);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const ny = (flat[2 * b + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]) - (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]);
    if (ny < 0) {
      tris[t + 1] = c;
      tris[t + 2] = b;
    }
  }
  return { flat, tris, n };
}

class Bounds {
  constructor() {
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
  }
  add(x, y, z) {
    const a = this.min, b = this.max;
    if (x < a[0]) a[0] = x;
    if (y < a[1]) a[1] = y;
    if (z < a[2]) a[2] = z;
    if (x > b[0]) b[0] = x;
    if (y > b[1]) b[1] = y;
    if (z > b[2]) b[2] = z;
  }
  sphere() {
    const a = this.min, b = this.max;
    if (a[0] === Infinity) return { center: [0, 0, 0], radius: 0 };
    const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    return { center, radius: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 2 };
  }
}

// ---------- roads ----------

function halfWidth(r) {
  if (r.cls === 7) return 3.5;
  const oneway = (r.flags & 4) !== 0;
  if (r.cls === 6) return (r.lanes * 3.6 + 1.5) / 2;
  if (oneway) return (r.lanes * 3.6 + 2) / 2;
  return (Math.max(r.lanes, 2) * 3.3 + 1.2) / 2;
}

function buildRoads(list, e0, n0) {
  const use = list.filter((r) => !(r.flags & 2) && r.pts.length >= 4);
  const isMinor = (r) => r.cls === 4 || r.cls === 5;
  // Major classes first, so a far tile can draw only the first part of the index buffer.
  const order = use.filter((r) => !isMinor(r)).concat(use.filter(isMinor));
  let nVert = 0, nIdx = 0, nMajor = 0;
  for (const r of order) {
    const n = r.pts.length / 2;
    nVert += n * 2;
    nIdx += (n - 1) * 6;
    if (!isMinor(r)) nMajor += (n - 1) * 6;
  }
  const pos = new Float32Array(nVert * 3);
  const uv = new Float32Array(nVert * 2);
  const info = new Uint8Array(nVert * 4);
  const idx = new Uint32Array(nIdx);
  const bounds = new Bounds();
  const lights = [];
  let v = 0, ii = 0;

  for (const r of order) {
    const pts = r.pts, n = pts.length / 2;
    const hw = halfWidth(r);
    const hwByte = Math.min(255, Math.round(hw * 8));
    const y = ROAD_Y + (r.cls === 7 ? 0.3 : (5 - Math.min(r.cls, 5)) * 0.02) + (r.flags & 1 ? 0.25 : 0) + Math.max(0, r.layer) * 0.12;
    const lit = r.cls <= 2;
    let along = 0, nextLight = LIGHT_SPACING / 2;
    const base = v;
    for (let j = 0; j < n; j++) {
      const x = pts[2 * j], q = pts[2 * j + 1];
      // Segment directions before and after this vertex.
      let ax = 0, an = 0, bx = 0, bn = 0;
      if (j > 0) { ax = x - pts[2 * j - 2]; an = q - pts[2 * j - 1]; const l = Math.hypot(ax, an) || 1; ax /= l; an /= l; }
      if (j < n - 1) { bx = pts[2 * j + 2] - x; bn = pts[2 * j + 3] - q; const l = Math.hypot(bx, bn) || 1; bx /= l; bn /= l; }
      if (j === 0) { ax = bx; an = bn; }
      if (j === n - 1) { bx = ax; bn = an; }
      let tx = ax + bx, tn = an + bn;
      const tl = Math.hypot(tx, tn);
      if (tl < 1e-4) { tx = bx; tn = bn; } else { tx /= tl; tn /= tl; }
      // Left normal of the tangent, lengthened at bends (mitre), capped at 2x.
      const lx = -tn, ln = tx;
      const cosHalf = Math.max(0.5, lx * -bn + ln * bx);
      const m = hw / cosHalf;
      for (let side = -1; side <= 1; side += 2) {
        const px = x + lx * m * -side, pn = q + ln * m * -side; // side -1 = left, +1 = right
        pos[v * 3] = px; pos[v * 3 + 1] = y; pos[v * 3 + 2] = -pn;
        uv[v * 2] = side; uv[v * 2 + 1] = along;
        info[v * 4] = r.cls; info[v * 4 + 1] = r.lanes; info[v * 4 + 2] = r.flags; info[v * 4 + 3] = hwByte;
        bounds.add(px, y, -pn);
        v++;
      }
      if (j < n - 1) {
        const segLen = Math.hypot(pts[2 * j + 2] - x, pts[2 * j + 3] - q);
        if (lit) {
          while (nextLight <= along + segLen) {
            const f = (nextLight - along) / (segLen || 1);
            lights.push(e0 + x + (pts[2 * j + 2] - x) * f, 11, -(n0 + q + (pts[2 * j + 3] - q) * f));
            nextLight += LIGHT_SPACING;
          }
        }
        along += segLen;
        const l0 = base + 2 * j, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
        idx[ii++] = r0; idx[ii++] = r1; idx[ii++] = l1;
        idx[ii++] = r0; idx[ii++] = l1; idx[ii++] = l0;
      }
    }
  }
  return { position: pos, uv, info, index: idx, majorIndexCount: nMajor, ...bounds.sphere(), lights: new Float32Array(lights) };
}

function buildTile(tile) {
  const e0 = GRID_MIN + tile.tx * TILE_SIZE, n0 = GRID_MIN + tile.ty * TILE_SIZE;
  const buildings = buildBuildings(tile.buildings, tile.nTall, e0, n0, { normRing, triangulate, Bounds, bay: BAY });
  const roads = buildRoads(tile.roads, e0, n0);
  const transfer = [];
  for (const part of [buildings, roads]) for (const k in part) if (ArrayBuffer.isView(part[k])) transfer.push(part[k].buffer);
  return { data: { tx: tile.tx, ty: tile.ty, origin: [e0, 0, -n0], buildings, roads }, transfer };
}

// ---------- land ----------

/** kind attribute: 0 land top, 1 green, 2 beach, 3 quay wall. Coordinates are global scene metres. */
function buildLand(polys) {
  const out = {};
  for (const layer of ['land', 'cover']) {
    const isLand = layer === 'land';
    const prep = [];
    let nVert = 0, nIdx = 0;
    for (const p of polys) {
      if ((p.kind === 0) !== isLand) continue;
      const outer = normRing(p.rings[0], false);
      if (!outer) continue;
      const rings = [outer];
      for (let k = 1; k < p.rings.length; k++) {
        const h = normRing(p.rings[k], true);
        if (h) rings.push(h);
      }
      const tri = triangulate(rings);
      nVert += tri.n * (isLand ? 5 : 1);
      nIdx += tri.tris.length + (isLand ? tri.n * 6 : 0);
      prep.push({ kind: p.kind, rings, tri });
    }
    const pos = new Float32Array(nVert * 3);
    const kind = new Uint8Array(nVert);
    const idx = new Uint32Array(nIdx);
    let v = 0, ii = 0;
    const y = isLand ? LAND_Y : COVER_Y;
    for (const p of prep) {
      const { flat, tris, n } = p.tri;
      const base = v;
      for (let j = 0; j < n; j++) {
        pos[v * 3] = flat[2 * j]; pos[v * 3 + 1] = y; pos[v * 3 + 2] = flat[2 * j + 1];
        kind[v++] = p.kind;
      }
      for (let t = 0; t < tris.length; t++) idx[ii++] = base + tris[t];
      if (!isLand) continue;
      for (const r of p.rings) {
        const m = r.length / 2;
        for (let j = 0; j < m; j++) {
          const k = (j + 1) % m;
          const a = v;
          const q = [[r[2 * j], 0, -r[2 * j + 1]], [r[2 * k], 0, -r[2 * k + 1]], [r[2 * k], LAND_Y, -r[2 * k + 1]], [r[2 * j], LAND_Y, -r[2 * j + 1]]];
          for (const c of q) {
            pos[v * 3] = c[0]; pos[v * 3 + 1] = c[1]; pos[v * 3 + 2] = c[2];
            kind[v++] = 3;
          }
          idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = a + 2;
          idx[ii++] = a; idx[ii++] = a + 2; idx[ii++] = a + 3;
        }
      }
    }
    out[layer] = { position: pos, kind, index: idx };
  }
  return { data: out, transfer: [out.land.position.buffer, out.land.kind.buffer, out.land.index.buffer, out.cover.position.buffer, out.cover.kind.buffer, out.cover.index.buffer] };
}
