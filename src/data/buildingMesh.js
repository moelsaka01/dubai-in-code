// Building mesher, used by the tile worker. Walls, roofs, and what stands on top of a tower.
// Vertex layout: position, normal (xyz + kind), uv3 (bays along the wall, metres above ground, top of this
// volume), colour (sRGB + seed). Buildings stay in tile order (tallest first) so LOD can cut the index buffer.

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
function centroid(r) {
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

function inside(r, x, y) {
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

/**
 * What stands on top of a tower. A plain extruded footprint is what makes a skyline look like blocks, so
 * compact towers get a stepped crown, a plant-room box or a mast, chosen by the seed.
 * Returns extra volumes and may lower the top of the main one.
 */
function crown(b, outer, main) {
  const h = b.height;
  if (h < 55 || b.isPart || b.kind === 3 || b.kind === 4 || b.kind === 7) return [];
  const [cx, cy, area] = centroid(outer);
  const bb = bbox(outer);
  if (!(area > 220) || area / ((bb[1] - bb[0]) * (bb[3] - bb[2])) < 0.55 || !inside(outer, cx, cy)) return [];
  const ring = (k) => [scaled(outer, cx, cy, k)];
  const out = [];
  const style = (b.seed * 7 + 3) % 6;
  const box = Math.min(10, Math.max(4, h * 0.04));
  if (style === 0) out.push({ rings: ring(0.62), y0: h, y1: h + box });
  else if (style === 1) out.push({ rings: ring(0.45), y0: h, y1: h + box * 1.3 });
  else if (style === 2) {
    main.y1 = h * 0.9;
    out.push({ rings: ring(0.8), y0: main.y1, y1: h }, { rings: ring(0.5), y0: h, y1: h + box * 0.8 });
  } else if (style === 3) {
    main.y1 = h * 0.86;
    out.push({ rings: ring(0.82), y0: main.y1, y1: h * 0.95 }, { rings: ring(0.6), y0: h * 0.95, y1: h });
    const m = 1.3, top = h + Math.min(45, Math.max(12, h * 0.14));
    out.push({ rings: [new Float32Array([cx - m, cy - m, cx + m, cy - m, cx + m, cy + m, cx - m, cy + m])], y0: h, y1: top });
  } else if (style === 4) {
    main.y1 = h * 0.94;
    out.push({ rings: ring(0.9), y0: main.y1, y1: h });
  }
  return out;
}

/**
 * @param {object[]} list decoded buildings, tallest first
 * @param {number} nTall how many are >= 40 m
 * @param {{ normRing: Function, triangulate: Function, Bounds: Function, bay: number }} h shared helpers
 */
export function buildBuildings(list, nTall, e0, n0, h) {
  // Pass 1: clean rings, add crowns, triangulate roofs, count.
  const prep = new Array(list.length);
  let nVert = 0, nIdx = 0;
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
    const main = { rings, y0, y1: b.height };
    const prisms = [main, ...crown(b, outer, main)];
    for (const p of prisms) {
      p.tri = h.triangulate(p.rings);
      p.caps = p.y0 > 0.5 && p === main ? 2 : 1; // an underside when the main volume floats
      nVert += p.tri.n * 4 + p.tri.n * p.caps;
      nIdx += p.tri.n * 6 + p.tri.tris.length * p.caps;
    }
    prep[i] = { b, prisms };
  }

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

  for (let i = 0; i < list.length; i++) {
    if (i === nTall) tallIndexCount = ii;
    const p = prep[i];
    if (!p) continue;
    const { b, prisms } = p;
    const kind = b.kind, seed = b.seed;
    const c = colors(kind, seed);
    let peak = 0, px = 0, pz = 0;

    for (const prism of prisms) {
      const { rings, tri, y0, y1 } = prism;
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
          const a = put(ax, y0, -an, nx, 0, nz, kind, u0, y1, c.wall, seed);
          put(bx, y0, -bn, nx, 0, nz, kind, u1, y1, c.wall, seed);
          put(bx, y1, -bn, nx, 0, nz, kind, u1, y1, c.wall, seed);
          put(ax, y1, -an, nx, 0, nz, kind, u0, y1, c.wall, seed);
          idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = a + 2;
          idx[ii++] = a; idx[ii++] = a + 2; idx[ii++] = a + 3;
        }
      }

      // Roof, and an underside for floating volumes.
      const { flat, tris, n } = tri;
      const base = v;
      let cx = 0, cz = 0;
      for (let j = 0; j < n; j++) {
        const x = flat[2 * j], z = flat[2 * j + 1];
        put(x, y1, z, 0, 127, 0, kind, 0, y1, c.roof, seed);
        bounds.add(x, y1, z);
        bounds.add(x, y0, z);
        cx += x; cz += z;
      }
      for (let t = 0; t < tris.length; t++) idx[ii++] = base + tris[t];
      if (prism.caps === 2) {
        const under = v;
        for (let j = 0; j < n; j++) put(flat[2 * j], y0, flat[2 * j + 1], 0, -127, 0, kind, 0, y1, c.wall, seed);
        for (let t = 0; t < tris.length; t += 3) {
          idx[ii++] = under + tris[t]; idx[ii++] = under + tris[t + 2]; idx[ii++] = under + tris[t + 1];
        }
      }
      if (y1 > peak) { peak = y1; px = cx / n; pz = cz / n; }
    }
    if (b.height >= 150) beacons.push(e0 + px, peak + 4, -n0 + pz);
  }
  if (nTall >= list.length) tallIndexCount = ii;

  return { position: pos, normal: nor, uv, color: col, index: idx, tallIndexCount, ...bounds.sphere(), beacons: new Float32Array(beacons) };
}
