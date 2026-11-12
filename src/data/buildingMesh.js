// Building mesher, used by the tile worker. Walls, roofs, and everything that keeps a footprint from being a box:
// a podium under large towers, a crown on top of them, pitched roofs on villas, plant on flat roofs.
// Vertex layout: position, normal (xyz + kind), uv3 (bays along the wall, metres above ground, top of this
// volume), colour (sRGB + seed). Buildings stay in tile order (tallest first) so LOD can cut the index buffer:
// [buildings >= 40 m][all other buildings][roof plant].

// sRGB bytes; the shader squares them as a cheap decode. Indexed by `kind` (PLAN §2 step 6).
// Muted on purpose: real facades are greyer than memory suggests, and glass takes its colour from the sky.
const WALLS = [
  [[214, 205, 188], [205, 198, 184], [222, 216, 204], [196, 190, 180], [186, 180, 168], [216, 206, 190], [176, 172, 166]], // 0 generic
  [[122, 140, 150], [106, 128, 142], [138, 150, 152], [100, 112, 128], [140, 150, 140], [124, 128, 134], [150, 142, 126], [90, 104, 112]], // 1 glass tower
  [[218, 208, 190], [224, 218, 206], [206, 194, 174], [212, 202, 190], [228, 222, 212], [196, 186, 172]], // 2 residential
  [[234, 228, 214], [228, 218, 202], [238, 234, 226], [222, 210, 190]], // 3 villa
  [[188, 190, 192], [202, 202, 198], [176, 182, 188], [208, 206, 198]], // 4 industrial
  [[218, 210, 196], [208, 202, 194], [224, 220, 212]], // 5 retail
  [[228, 220, 198], [236, 230, 218], [218, 204, 178]], // 6 civic / mosque
  [[198, 198, 196], [210, 208, 204]], // 7 roof / canopy
];
const ROOF_GREY = [[150, 148, 142], [164, 160, 154], [136, 134, 130], [176, 172, 164]];
const ROOF_TILE = [[168, 108, 82], [152, 98, 78], [178, 122, 94]];
const ROOF_METAL = [[196, 198, 200], [152, 160, 168], [208, 208, 204]];
const ROOF_TOWER = [[96, 98, 100], [116, 116, 116], [84, 86, 90]];
const PLANT = [[178, 180, 182], [206, 206, 202], [128, 132, 136], [222, 222, 218]];
const KIND_PLANT = 4; // rooftop boxes are drawn like sheds: no windows

function colors(kind, seed) {
  const pal = WALLS[kind] || WALLS[0];
  const w = pal[seed % pal.length];
  const j = 0.9 + 0.2 * (((seed * 37) % 64) / 63);
  let r;
  if (kind === 3) r = seed % 5 < 3 ? ROOF_TILE[seed % 3] : [206, 200, 188];
  else if (kind === 4) r = ROOF_METAL[seed % 3];
  else if (kind === 1) r = ROOF_TOWER[seed % 3];
  else if (kind === 7) r = w;
  else r = ROOF_GREY[seed % 4];
  return { wall: [w[0] * j, w[1] * j, w[2] * j], roof: r };
}

function bbox(r) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < x0) x0 = r[i];
    if (r[i] > x1) x1 = r[i];
    if (r[i + 1] < y0) y0 = r[i + 1];
    if (r[i + 1] > y1) y1 = r[i + 1];
  }
  return [x0, x1, y0, y1];
}

/** Area centroid and signed area of a ring. */
export function centroid(r) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    const c = r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
    a += c;
    cx += (r[2 * i] + r[2 * j]) * c;
    cy += (r[2 * i + 1] + r[2 * j + 1]) * c;
  }
  return [cx / (3 * a), cy / (3 * a), a / 2];
}

export function inside(r, x, y) {
  let c = false;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function scaled(r, cx, cy, k) {
  const o = new Float32Array(r.length);
  for (let i = 0; i < r.length; i += 2) {
    o[i] = cx + (r[i] - cx) * k;
    o[i + 1] = cy + (r[i + 1] - cy) * k;
  }
  return o;
}

/** Small deterministic generator, so a rebuild gives the same city. */
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compact(ring) {
  const [cx, cy, area] = centroid(ring);
  const bb = bbox(ring);
  const w = bb[1] - bb[0], d = bb[3] - bb[2];
  return { cx, cy, area, w, d, ok: area / (w * d) >= 0.5 && inside(ring, cx, cy) };
}

/**
 * Large towers in Dubai stand on a parking and retail podium with a slimmer shaft above it.
 * Lowers `main` to the podium and returns the shaft, or null when the footprint is too small or irregular.
 */
function podium(b, outer, main) {
  const h = b.height;
  if (h < 45 || b.isPart || main.y0 > 0.5 || !(b.kind === 0 || b.kind === 1 || b.kind === 2 || b.kind === 5)) return null;
  const c = compact(outer);
  if (!c.ok || c.area < 900 || (b.seed * 13 + 5) % 4 === 0) return null; // a quarter stay plain shafts
  const ph = Math.min(h * 0.3, 8 + ((b.seed >> 2) % 4) * 4);
  const k = c.area > 3000 ? 0.6 + (b.seed % 5) * 0.04 : 0.74 + (b.seed % 4) * 0.04;
  // The shaft sits toward one side of the podium, not dead centre.
  const a = ((b.seed % 8) * Math.PI) / 4, off = (1 - k) * 0.3;
  let px = c.cx + Math.cos(a) * c.w * off, py = c.cy + Math.sin(a) * c.d * off;
  if (!inside(outer, px, py)) { px = c.cx; py = c.cy; }
  main.y1 = ph;
  return { rings: [scaled(outer, px, py, k)], y0: ph, y1: h };
}

/**
 * What stands on top of a tower: a stepped crown, a plant-room box or a mast, chosen by the seed.
 * Returns extra volumes and may lower the top of `shaft`.
 */
function crown(b, ring, shaft) {
  const h = b.height;
  if (h < 55 || b.isPart || b.kind === 3 || b.kind === 4 || b.kind === 7) return [];
  const c = compact(ring);
  if (!c.ok || c.area < 220 || c.area / (c.w * c.d) < 0.55) return [];
  const { cx, cy } = c;
  const tier = (k) => [scaled(ring, cx, cy, k)];
  const out = [];
  const style = (b.seed * 7 + 3) % 6;
  const box = Math.min(10, Math.max(4, h * 0.04));
  if (style === 0) out.push({ rings: tier(0.62), y0: h, y1: h + box });
  else if (style === 1) out.push({ rings: tier(0.45), y0: h, y1: h + box * 1.3 });
  else if (style === 2) {
    shaft.y1 = h * 0.9;
    out.push({ rings: tier(0.8), y0: shaft.y1, y1: h }, { rings: tier(0.5), y0: h, y1: h + box * 0.8 });
  } else if (style === 3) {
    shaft.y1 = h * 0.86;
    out.push({ rings: tier(0.82), y0: shaft.y1, y1: h * 0.95 }, { rings: tier(0.6), y0: h * 0.95, y1: h });
    const m = 1.3, top = h + Math.min(45, Math.max(12, h * 0.14));
    out.push({ rings: [new Float32Array([cx - m, cy - m, cx + m, cy - m, cx + m, cy + m, cx - m, cy + m])], y0: h, y1: top });
  } else if (style === 4) {
    shaft.y1 = h * 0.94;
    out.push({ rings: tier(0.9), y0: shaft.y1, y1: h });
  }
  return out;
}

/** Rise of a pitched roof for a villa, or 0 when every wall cannot see the centre point. */
function pitch(b, ring) {
  if (b.kind !== 3 || ring.length > 24) return 0;
  const [cx, cy, area] = centroid(ring);
  if (!(area > 40)) return 0;
  let reach = Infinity;
  for (let i = 0, n = ring.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    const ex = ring[2 * j] - ring[2 * i], ey = ring[2 * j + 1] - ring[2 * i + 1];
    const len = Math.hypot(ex, ey) || 1;
    const dist = (ex * (cy - ring[2 * i + 1]) - ey * (cx - ring[2 * i])) / len; // > 0 when the centre is inside this edge
    if (dist < 0.5) return 0;
    if (dist < reach) reach = dist;
  }
  return Math.min(3.2, Math.max(1.2, reach * 0.45));
}

/** Chillers, tanks and stair heads: a few boxes at random spots on a flat roof, aligned with its longest wall. */
function plant(ring, hole, y, seed, out) {
  const bb = bbox(ring);
  const [, , area] = centroid(ring);
  if (area < 180) return;
  let ang = 0, longest = 0;
  for (let i = 0, n = ring.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    const ex = ring[2 * j] - ring[2 * i], ey = ring[2 * j + 1] - ring[2 * i + 1];
    const l = ex * ex + ey * ey;
    if (l > longest) { longest = l; ang = Math.atan2(ey, ex); }
  }
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const rnd = rng(seed * 2654435761);
  const want = Math.min(5, Math.max(1, Math.round(area / 320)));
  for (let made = 0, tries = 0; made < want && tries < want * 8; tries++) {
    const x = bb[0] + rnd() * (bb[1] - bb[0]), yy = bb[2] + rnd() * (bb[3] - bb[2]);
    const hw = 1 + rnd() * 2, hd = 1 + rnd() * 1.6;
    const box = new Float32Array(8);
    let ok = true;
    for (let k = 0; k < 4 && ok; k++) {
      const lx = (k === 0 || k === 3 ? -hw : hw), ly = (k < 2 ? -hd : hd);
      const px = x + lx * ca - ly * sa, py = yy + lx * sa + ly * ca;
      box[2 * k] = px;
      box[2 * k + 1] = py;
      // Stay a metre clear of the roof edge, and off the shaft that stands on a podium.
      const mx = x + (px - x) * 1.5, my = yy + (py - yy) * 1.5;
      ok = inside(ring, mx, my) && !(hole && inside(hole, mx, my));
    }
    if (!ok || (hole && inside(hole, x, yy))) continue;
    out.push({ rings: [box], y0: y, y1: y + 1.2 + rnd() * 2.4, color: PLANT[Math.floor(rnd() * PLANT.length)], seed: Math.floor(rnd() * 255) });
    made++;
  }
}

/**
 * @param {object[]} list decoded buildings, tallest first
 * @param {number} nTall how many are >= 40 m
 * @param {{ normRing: Function, triangulate: Function, Bounds: Function, bay: number }} h shared helpers
 */
export function buildBuildings(list, nTall, e0, n0, h) {
  // Pass 1: clean rings, work out the massing, triangulate roofs, count.
  const prep = new Array(list.length);
  const details = [];
  let nVert = 0, nIdx = 0;
  const count = (p) => {
    const n = p.rings.reduce((s, r) => s + r.length / 2, 0);
    if (p.rise) {
      nVert += n * 4 + n * 3;
      nIdx += n * 6 + n * 3;
    } else {
      p.tri = h.triangulate(p.rings);
      nVert += p.tri.n * 4 + p.tri.n * (p.caps || 1);
      nIdx += p.tri.n * 6 + p.tri.tris.length * (p.caps || 1);
    }
  };
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const outer = h.normRing(b.rings[0], false);
    if (!outer) continue;
    const rings = [outer];
    for (let k = 1; k < b.rings.length; k++) {
      const hole = h.normRing(b.rings[k], true);
      if (hole) rings.push(hole);
    }
    let y0 = b.minHeight;
    if (b.kind === 7) y0 = Math.max(y0, b.height - 0.6); // canopies are thin slabs
    if (y0 >= b.height) y0 = Math.max(0, b.height - 3);
    if (y0 > 15 && b.kind !== 7) {
      // A part that starts high up needs something under it. If its lower parts were lost, stand it on the ground.
      const [cx, cy] = centroid(outer);
      let held = false;
      for (let j = 0; j < list.length && !held; j++) {
        const o = list[j];
        if (j === i || o.minHeight >= y0 || o.height < y0 - 3) continue;
        const bb = bbox(o.rings[0]);
        held = cx >= bb[0] && cx <= bb[1] && cy >= bb[2] && cy <= bb[3];
      }
      if (!held) y0 = 0;
    }
    const main = { rings, y0, y1: b.height, caps: y0 > 0.5 ? 2 : 1 }; // an underside when the volume floats
    const prisms = [main];
    const simple = rings.length === 1;
    const shaft = simple ? podium(b, outer, main) : null;
    if (shaft) prisms.push(shaft);
    const top = shaft || main;
    const extras = simple ? crown(b, top.rings[0], top) : [];
    prisms.push(...extras);
    if (simple && !shaft && !extras.length) main.rise = pitch(b, outer);
    // Roof plant on the focus districts only: on the podium around the shaft, and on plain flat roofs.
    if (simple && !b.tierB && b.kind !== 3 && b.kind !== 7 && b.height >= 6) {
      if (shaft) plant(outer, shaft.rings[0], main.y1, b.seed * 131 + i, details);
      if (!extras.length && !main.rise) plant(top.rings[0], null, top.y1, b.seed * 137 + i + 7, details);
    }
    prisms.forEach(count);
    prep[i] = { b, prisms };
  }
  details.forEach(count);

  const pos = new Float32Array(nVert * 3);
  const nor = new Int8Array(nVert * 4);
  const uv = new Float32Array(nVert * 3);
  const col = new Uint8Array(nVert * 4);
  const idx = new Uint32Array(nIdx);
  const bounds = new h.Bounds();
  const beacons = [];
  let v = 0, ii = 0, tallIndexCount = 0;

  const put = (x, y, z, nx, ny, nz, kind, u, top, c, seed) => {
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    nor[v * 4] = nx; nor[v * 4 + 1] = ny; nor[v * 4 + 2] = nz; nor[v * 4 + 3] = kind;
    uv[v * 3] = u; uv[v * 3 + 1] = y; uv[v * 3 + 2] = top;
    col[v * 4] = c[0]; col[v * 4 + 1] = c[1]; col[v * 4 + 2] = c[2]; col[v * 4 + 3] = seed;
    return v++;
  };

  /** Emit one volume. Returns the centre of its roof. */
  function emit(prism, kind, seed, wall, roof) {
    const { rings, y0, y1 } = prism;
    // Walls. For a plan edge (de, dn) on a CCW ring the outward normal is (dn, -de), which is (dn, 0, de) in the scene.
    let cum = seed % 7;
    for (const r of rings) {
      const n = r.length / 2;
      for (let j = 0; j < n; j++) {
        const k = (j + 1) % n;
        const ax = r[2 * j], an = r[2 * j + 1], bx = r[2 * k], bn = r[2 * k + 1];
        const de = bx - ax, dn = bn - an;
        const len = Math.hypot(de, dn) || 1;
        const nx = Math.round((dn / len) * 127), nz = Math.round((de / len) * 127);
        const bays = len < 2 ? 0 : Math.max(1, Math.round(len / h.bay)); // whole bays per wall, so windows never straddle a corner
        const u0 = cum, u1 = cum + bays;
        cum = u1;
        const a = put(ax, y0, -an, nx, 0, nz, kind, u0, y1, wall, seed);
        put(bx, y0, -bn, nx, 0, nz, kind, u1, y1, wall, seed);
        put(bx, y1, -bn, nx, 0, nz, kind, u1, y1, wall, seed);
        put(ax, y1, -an, nx, 0, nz, kind, u0, y1, wall, seed);
        idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = a + 2;
        idx[ii++] = a; idx[ii++] = a + 2; idx[ii++] = a + 3;
      }
    }

    if (prism.rise) {
      // Pitched roof: one flat-shaded triangle per wall, meeting above the centre.
      const r = rings[0], n = r.length / 2;
      const [cx, cy] = centroid(r);
      const apex = y1 + prism.rise;
      for (let j = 0; j < n; j++) {
        const k = (j + 1) % n;
        const ax = r[2 * j], az = -r[2 * j + 1], bx = r[2 * k], bz = -r[2 * k + 1];
        // Normal of (a, b, apex); the winding that faces up is a -> b -> apex for a CCW ring.
        const ux = bx - ax, uz = bz - az, vx = cx - ax, vy = prism.rise, vz = -cy - az;
        let nx = -uz * vy, ny = uz * vx - ux * vz, nz = ux * vy;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx = Math.round((nx / l) * 127); ny = Math.round((ny / l) * 127); nz = Math.round((nz / l) * 127);
        const a = put(ax, y1, az, nx, ny, nz, kind, 0, apex, roof, seed);
        put(bx, y1, bz, nx, ny, nz, kind, 0, apex, roof, seed);
        put(cx, apex, -cy, nx, ny, nz, kind, 0, apex, roof, seed);
        idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = a + 2;
        bounds.add(ax, y0, az);
      }
      bounds.add(cx, apex, -cy);
      return [cx, -cy, apex];
    }

    // Flat roof, and an underside for floating volumes.
    const { flat, tris, n } = prism.tri;
    const base = v;
    let cx = 0, cz = 0;
    for (let j = 0; j < n; j++) {
      const x = flat[2 * j], z = flat[2 * j + 1];
      put(x, y1, z, 0, 127, 0, kind, 0, y1, roof, seed);
      bounds.add(x, y1, z);
      bounds.add(x, y0, z);
      cx += x; cz += z;
    }
    for (let t = 0; t < tris.length; t++) idx[ii++] = base + tris[t];
    if (prism.caps === 2) {
      const under = v;
      for (let j = 0; j < n; j++) put(flat[2 * j], y0, flat[2 * j + 1], 0, -127, 0, kind, 0, y1, wall, seed);
      for (let t = 0; t < tris.length; t += 3) {
        idx[ii++] = under + tris[t]; idx[ii++] = under + tris[t + 2]; idx[ii++] = under + tris[t + 1];
      }
    }
    return [cx / n, cz / n, y1];
  }

  for (let i = 0; i < list.length; i++) {
    if (i === nTall) tallIndexCount = ii;
    const p = prep[i];
    if (!p) continue;
    const { b, prisms } = p;
    const c = colors(b.kind, b.seed);
    let peak = [0, 0, 0];
    for (const prism of prisms) {
      const t = emit(prism, b.kind, b.seed, c.wall, c.roof);
      if (t[2] > peak[2]) peak = t;
    }
    if (b.height >= 150) beacons.push(e0 + peak[0], peak[2] + 4, -n0 + peak[1]);
  }
  if (nTall >= list.length) tallIndexCount = ii;
  const bodyIndexCount = ii;
  for (const d of details) emit(d, KIND_PLANT, d.seed, d.color, d.color);

  return { position: pos, normal: nor, uv, color: col, index: idx, tallIndexCount, bodyIndexCount, ...bounds.sphere(), beacons: new Float32Array(beacons) };
}
