// Tile worker: fetch + decode a tile, triangulate roofs, build walls and road ribbons, and hand typed arrays back.
// Geometry is tile-local: x = east, y = up, z = -north, relative to the tile's south-west corner.
// Flipping north to -z is handled here once: plan-CCW rings give outward walls and upward roofs (see wall()).
import earcut from 'earcut';
import { decodeTile, decodeLand } from '../shared/format.js';
import { TILE_SIZE, GRID_MIN } from '../shared/config.js';
import { buildBuildings, centroid, inside, rng } from './buildingMesh.js';
import { deckHeight, isRaised, nodeKey, liftOf } from '../shared/bridges.js';

const LAND_Y = 1.5; // top of the land slab
const COVER_Y = 1.55; // parks and beaches
const ROAD_Y = 1.6;
const BAY = 3.1; // target window bay width in metres
const LIGHT_SPACING = 40;
const PIER_SPACING = 36, PIER_HALF = 0.9;
// Where bridge ways meet, city-wide: key -> [distance to ground, reach, deck height]. Sent once by the loader
// before the first tile (public/data/bridges.json). Without it every bridge is treated as standing alone.
const BRIDGE_NODES = new Map();

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'bridges') {
    for (let i = 0; i < m.nodes.length; i += 5) BRIDGE_NODES.set(nodeKey(m.nodes[i], m.nodes[i + 1]), [m.nodes[i + 2], m.nodes[i + 3], m.nodes[i + 4]]);
    return;
  }
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

/**
 * Height profile of a raised way: returns (metres along it) -> metres above its base. Ends that meet another
 * bridge way, in this tile or the next, carry on at that way's height; ends that meet the ground ramp down.
 */
function bridgeLift(r, e0, n0) {
  const p = r.pts, n = p.length;
  let total = 0;
  for (let i = 2; i < n; i += 2) total += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  const a = BRIDGE_NODES.get(nodeKey(e0 + p[0], n0 + p[1])), b = BRIDGE_NODES.get(nodeKey(e0 + p[n - 2], n0 + p[n - 1]));
  const ref = a || b;
  const reach = ref ? ref[1] : total / 2, top = ref ? ref[2] : deckHeight(r.cls, r.layer);
  const dS = a ? a[0] : 0, dE = b ? b[0] : 0;
  return (s) => liftOf(s, total, dS, dE, reach, top);
}

function buildRoads(list, e0, n0) {
  const use = list.filter((r) => !(r.flags & 2) && r.pts.length >= 4);
  const isMinor = (r) => r.cls === 4 || r.cls === 5;
  // Major classes first, so a far tile can draw only the first part of the index buffer.
  const order = use.filter((r) => !isMinor(r)).concat(use.filter(isMinor));

  // Bridges rise off the ground: roads, motorways (their traffic follows, see traffic.js) and the Metro.
  const raised = isRaised;

  // Piers: a column under a raised deck every PIER_SPACING metres where it is high enough to need one, unless
  // the column would stand in a road that passes underneath.
  const ground = [];
  for (const r of order) {
    if (raised(r)) continue;
    const hw = halfWidth(r);
    for (let i = 0; i < r.pts.length - 2; i += 2) ground.push(r.pts[i], r.pts[i + 1], r.pts[i + 2], r.pts[i + 3], hw);
  }
  const blocked = (x, y) => {
    for (let g = 0; g < ground.length; g += 5) {
      const ax = ground[g], ay = ground[g + 1], dx = ground[g + 2] - ax, dy = ground[g + 3] - ay;
      if (Math.abs(x - ax) > 400 || Math.abs(y - ay) > 400) continue;
      const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(x - ax - dx * t, y - ay - dy * t) < ground[g + 4] + PIER_HALF + 0.6) return true;
    }
    return false;
  };
  const piers = []; // x, north, top, class
  for (const r of order) {
    if (!raised(r)) continue;
    const lift = bridgeLift(r, e0, n0), pts = r.pts;
    let along = 0, next = PIER_SPACING / 2;
    for (let j = 0; j < pts.length - 2; j += 2) {
      const len = Math.hypot(pts[j + 2] - pts[j], pts[j + 3] - pts[j + 1]);
      for (; next <= along + len; next += PIER_SPACING) {
        const f = (next - along) / (len || 1), h = lift(next);
        const x = pts[j] + (pts[j + 2] - pts[j]) * f, y = pts[j + 1] + (pts[j + 3] - pts[j + 1]) * f;
        if (h > 2.6 && !blocked(x, y)) piers.push(x, y, ROAD_Y + h - 1.2, r.cls);
      }
      along += len;
    }
  }

  let nVert = piers.length * 4, nIdx = (piers.length / 4) * 24, nMajor = 0;
  for (const r of order) {
    const n = r.pts.length / 2;
    const strips = raised(r) ? 3 : 1; // deck plus a skirt down each side
    nVert += n * 2 * strips;
    nIdx += (n - 1) * 6 * strips;
    if (!isMinor(r)) nMajor += (n - 1) * 6 * strips;
  }
  const pos = new Float32Array(nVert * 3);
  const uv = new Float32Array(nVert * 2);
  const side = new Float32Array(nVert * 2); // metres of sideways movement per metre of extra half-width
  const info = new Uint8Array(nVert * 4);
  const idx = new Uint32Array(nIdx);
  const bounds = new Bounds();
  const lights = [];
  let v = 0, ii = 0;

  for (const r of order) {
    const pts = r.pts, n = pts.length / 2;
    const hw = halfWidth(r);
    const hwByte = Math.min(255, Math.round(hw * 8));
    const base = ROAD_Y + (r.cls === 7 ? 0.3 : (5 - Math.min(r.cls, 5)) * 0.02) + Math.max(0, r.layer) * 0.12;
    const lit = r.cls <= 2;
    const up = raised(r);
    const lift = up ? bridgeLift(r, e0, n0) : null;

    let along = 0, nextLight = LIGHT_SPACING / 2;
    const first = v;
    const edge = []; // per vertex pair: left and right positions, for the skirts
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
      const y = base + (up ? lift(along) : 0);
      for (let s = -1; s <= 1; s += 2) {
        const px = x + lx * m * -s, pn = q + ln * m * -s; // s -1 = left, +1 = right
        pos[v * 3] = px; pos[v * 3 + 1] = y; pos[v * 3 + 2] = -pn;
        uv[v * 2] = s; uv[v * 2 + 1] = along;
        side[v * 2] = (lx * -s) / cosHalf; side[v * 2 + 1] = -(ln * -s) / cosHalf;
        info[v * 4] = r.cls; info[v * 4 + 1] = r.lanes; info[v * 4 + 2] = r.flags; info[v * 4 + 3] = hwByte;
        bounds.add(px, y, -pn);
        edge.push(px, y, -pn);
        v++;
      }
      if (j < n - 1) {
        const segLen = Math.hypot(pts[2 * j + 2] - x, pts[2 * j + 3] - q);
        if (lit) {
          while (nextLight <= along + segLen) {
            const f = (nextLight - along) / (segLen || 1);
            lights.push(e0 + x + (pts[2 * j + 2] - x) * f, 11 + (up ? lift(nextLight) : 0), -(n0 + q + (pts[2 * j + 3] - q) * f));
            nextLight += LIGHT_SPACING;
          }
        }
        along += segLen;
        const l0 = first + 2 * j, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
        idx[ii++] = r0; idx[ii++] = r1; idx[ii++] = l1;
        idx[ii++] = r0; idx[ii++] = l1; idx[ii++] = l0;
      }
    }
    if (!up) continue;
    // Skirts: the deck edge dropped 1.4 m, so a bridge has thickness. Marked with |uv.x| = 2 for the shader.
    for (let s = 0; s < 2; s++) {
      const start = v;
      for (let j = 0; j < n; j++) {
        const o = (j * 2 + s) * 3;
        for (let k = 0; k < 2; k++) {
          pos[v * 3] = edge[o]; pos[v * 3 + 1] = edge[o + 1] - k * 1.4; pos[v * 3 + 2] = edge[o + 2];
          uv[v * 2] = s ? 2 : -2; uv[v * 2 + 1] = 0;
          const src = first + j * 2 + s;
          side[v * 2] = side[src * 2]; side[v * 2 + 1] = side[src * 2 + 1];
          info[v * 4] = r.cls; info[v * 4 + 1] = r.lanes; info[v * 4 + 2] = r.flags; info[v * 4 + 3] = hwByte;
          v++;
        }
      }
      for (let j = 0; j < n - 1; j++) {
        const a = start + j * 2;
        idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = a + 3;
        idx[ii++] = a; idx[ii++] = a + 3; idx[ii++] = a + 2;
      }
    }
  }
  // Piers go last in the index buffer, so they disappear with the minor roads at a distance.
  for (let k = 0; k < piers.length; k += 4) {
    const x = piers[k], q = piers[k + 1], top = piers[k + 2];
    const cx = [-1, 1, 1, -1], cq = [-1, -1, 1, 1];
    for (let f = 0; f < 4; f++) {
      const g = (f + 1) % 4, a = v;
      for (const [c, y] of [[f, LAND_Y], [g, LAND_Y], [g, top], [f, top]]) {
        pos[v * 3] = x + cx[c] * PIER_HALF; pos[v * 3 + 1] = y; pos[v * 3 + 2] = -(q + cq[c] * PIER_HALF);
        uv[v * 2] = 2; uv[v * 2 + 1] = 0;
        info[v * 4] = piers[k + 3]; info[v * 4 + 1] = 1; info[v * 4 + 2] = 1; info[v * 4 + 3] = 8;
        v++;
      }
      idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = a + 2;
      idx[ii++] = a; idx[ii++] = a + 2; idx[ii++] = a + 3;
    }
  }
  return { position: pos, uv, side, info, index: idx, majorIndexCount: nMajor, ...bounds.sphere(), lights: new Float32Array(lights) };
}

// ---------- street life ----------

const MAX_PALMS = 1500, MAX_CARS = 700;

/**
 * Where the things that are not on the map go. Palms line the main roads and stand in villa gardens; cars sit
 * on the streets (the motorways get moving ones from traffic.json). Each item is (x, z, size, heading) in scene metres.
 */
function buildProps(tile, e0, n0) {
  const palms = [], trees = [], cars = [];
  const rnd = rng(tile.tx * 7919 + tile.ty * 104729 + 17);
  // Every road segment of the tile in a coarse grid, to ask "is this spot on a road?" and "is it under a deck?".
  // A palm planted beside one road used to stand in the next carriageway wherever two roads run close together
  // (junctions, slip roads, bridge approaches), and cars stood under, and through, the bridges above them.
  const CELL = 40, grid = new Map();
  for (const r of tile.roads) {
    if (r.flags & 2) continue;
    const pts = r.pts, hw = halfWidth(r), deck = isRaised(r);
    for (let i = 0; i < pts.length - 2; i += 2) {
      const seg = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3], hw, deck, r];
      const x0 = Math.floor((Math.min(seg[0], seg[2]) - 16) / CELL), x1 = Math.floor((Math.max(seg[0], seg[2]) + 16) / CELL);
      const y0 = Math.floor((Math.min(seg[1], seg[3]) - 16) / CELL), y1 = Math.floor((Math.max(seg[1], seg[3]) + 16) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = x * 4096 + y;
        let cell = grid.get(k);
        if (!cell) grid.set(k, cell = []);
        cell.push(seg);
      }
    }
  }
  /** True when (x, y) is within `margin` of the edge of a road other than `own`; with decksOnly, of a raised deck. */
  const onRoad = (x, y, margin, own, decksOnly) => {
    const cell = grid.get(Math.floor(x / CELL) * 4096 + Math.floor(y / CELL));
    if (!cell) return false;
    for (const g of cell) {
      if (g[6] === own || (decksOnly && !g[5])) continue;
      const dx = g[2] - g[0], dy = g[3] - g[1];
      const t = Math.min(1, Math.max(0, ((x - g[0]) * dx + (y - g[1]) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(x - g[0] - dx * t, y - g[1] - dy * t) < g[4] + margin) return true;
    }
    return false;
  };
  for (const r of tile.roads) {
    if (r.flags & 3 || r.cls === 0 || r.cls >= 6) continue; // not on bridges, in tunnels, on motorways, ramps or rail
    const pts = r.pts, n = pts.length / 2;
    const hw = halfWidth(r);
    const lined = r.cls <= 4; // trunk to tertiary roads are planted
    const spacing = r.cls <= 3 ? 34 : 48;
    let nextPalm = 6 + rnd() * spacing, nextCar = 10 + rnd() * 60, along = 0, side = rnd() < 0.5 ? 1 : -1;
    for (let j = 0; j < n - 1; j++) {
      const ax = pts[2 * j], an = pts[2 * j + 1], bx = pts[2 * j + 2], bn = pts[2 * j + 3];
      const len = Math.hypot(bx - ax, bn - an);
      if (len < 0.5) continue;
      const dx = (bx - ax) / len, dn = (bn - an) / len;
      while (lined && nextPalm <= along + len && palms.length < MAX_PALMS * 4) {
        const f = nextPalm - along, off = (hw + 2.6) * side;
        // right of travel is (dn, -dx) in plan
        const px = ax + dx * f + dn * off, pn = an + dn * f - dx * off, size = 0.8 + rnd() * 0.5, turn = rnd() * 6.283;
        if (!onRoad(px, pn, 1.6, r, false)) palms.push(e0 + px, -(n0 + pn), size, turn);
        side = -side;
        nextPalm += spacing * (0.5 + rnd() * 0.25);
      }
      while (nextCar <= along + len && cars.length < MAX_CARS * 4) {
        const f = nextCar - along;
        const right = rnd() < 0.5 ? 1 : -1; // which side of the centre line; drive on the right
        const off = Math.min(hw - 1.3, 1.7 + Math.floor(rnd() * Math.max(1, r.lanes / 2)) * 3.3) * right;
        const heading = Math.atan2(dn * right, dx * right); // plan angle of travel
        const cx = ax + dx * f + dn * off, cn = an + dn * f - dx * off, size = 0.9 + rnd() * 0.25;
        if (!onRoad(cx, cn, 1.0, r, true)) cars.push(e0 + cx, -(n0 + cn), size, heading);
        nextCar += (r.cls === 5 ? 110 : 40) * (0.4 + rnd() * 1.6);
      }
      along += len;
    }
  }
  // A palm or a shade tree in most villa gardens.
  for (const b of tile.buildings) {
    if (b.kind !== 3 || rnd() > 0.7) continue;
    const ring = b.rings[0];
    const [cx, cy, area] = centroid(ring);
    if (!Number.isFinite(cx)) continue;
    const reach = Math.sqrt(Math.abs(area)) * 0.75 + 2.5, a = rnd() * 6.283;
    const x = cx + Math.cos(a) * reach, y = cy + Math.sin(a) * reach;
    if (inside(ring, x, y) || onRoad(x, y, 1.6, null, false)) continue;
    (rnd() < 0.6 ? palms : trees).push(e0 + x, -(n0 + y), 0.7 + rnd() * 0.5, rnd() * 6.283);
  }
  return { palms: new Float32Array(palms), trees: new Float32Array(trees), cars: new Float32Array(cars) };
}

function buildTile(tile) {
  const e0 = GRID_MIN + tile.tx * TILE_SIZE, n0 = GRID_MIN + tile.ty * TILE_SIZE;
  const buildings = buildBuildings(tile.buildings, tile.nTall, e0, n0, { normRing, triangulate, Bounds, bay: BAY });
  const roads = buildRoads(tile.roads, e0, n0);
  const props = buildProps(tile, e0, n0);
  const transfer = [];
  for (const part of [buildings, roads, props]) for (const k in part) if (ArrayBuffer.isView(part[k])) transfer.push(part[k].buffer);
  return { data: { tx: tile.tx, ty: tile.ty, origin: [e0, 0, -n0], buildings, roads, props }, transfer };
}

// ---------- land ----------

/** kind attribute: 0 land top, 1 green, 2 beach, 3 quay wall. Coordinates are global scene metres. */
function buildLand(polys) {
  const out = {};
  // Trees in parks and on golf courses: scattered inside every green polygon.
  const palms = [], trees = [];
  const rnd = rng(4242);
  for (const p of polys) {
    if (p.kind !== 1) continue;
    const ring = p.rings[0];
    const [, , a] = centroid(ring);
    const want = Math.min(160, Math.floor(Math.abs(a) / 420));
    if (want < 1) continue;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]);
      y0 = Math.min(y0, ring[i + 1]); y1 = Math.max(y1, ring[i + 1]);
    }
    for (let made = 0, tries = 0; made < want && tries < want * 5; tries++) {
      const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0);
      if (!inside(ring, x, y)) continue;
      (rnd() < 0.4 ? palms : trees).push(x, -y, 0.75 + rnd() * 0.6, rnd() * 6.283);
      made++;
    }
  }
  out.props = { palms: new Float32Array(palms), trees: new Float32Array(trees), cars: new Float32Array(0) };
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
  return { data: out, transfer: [out.land.position.buffer, out.land.kind.buffer, out.land.index.buffer, out.cover.position.buffer, out.cover.kind.buffer, out.cover.index.buffer, out.props.palms.buffer, out.props.trees.buffer] };
}
