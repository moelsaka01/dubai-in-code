// Binary codecs for tiles and land.bin. Little-endian. Shared by the Node pipeline and the browser.
// Plain ES module, no Node/browser-only APIs (uses DataView/Uint8Array only).

export const TILE_VERSION = 1;
export const LAND_VERSION = 1;
const MAGIC_TILE = [0x44, 0x58, 0x42, 0x31]; // "DXB1"
const MAGIC_LAND = [0x44, 0x58, 0x4c, 0x31]; // "DXL1"
const clampI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

class Writer {
  constructor() { this.buf = new Uint8Array(1 << 16); this.dv = new DataView(this.buf.buffer); this.n = 0; }
  need(k) {
    if (this.n + k <= this.buf.length) return;
    let len = this.buf.length; while (len < this.n + k) len *= 2;
    const nb = new Uint8Array(len); nb.set(this.buf); this.buf = nb; this.dv = new DataView(nb.buffer);
  }
  u8(v) { this.need(1); this.dv.setUint8(this.n, v); this.n += 1; }
  i8(v) { this.need(1); this.dv.setInt8(this.n, v); this.n += 1; }
  u16(v) { this.need(2); this.dv.setUint16(this.n, v, true); this.n += 2; }
  i16(v) { this.need(2); this.dv.setInt16(this.n, v, true); this.n += 2; }
  u32(v) { this.need(4); this.dv.setUint32(this.n, v, true); this.n += 4; }
  i32(v) { this.need(4); this.dv.setInt32(this.n, v, true); this.n += 4; }
  bytes() { return this.buf.slice(0, this.n); }
}

/**
 * Tile: { tx, ty, buildings, roads }
 * building: { height (m), minHeight (m), heightSrc 0-3, kind 0-7, tierB, isPart, seed 0-255, rings: [[x,y,...] metres relative to tile SW corner] }
 *   Buildings must already be sorted tallest-first; nTall = count with height >= 40 m.
 * road: { cls 0-7, lanes, flags, layer, pts: [x,y,...] metres relative to tile SW corner }
 */
export function encodeTile({ tx, ty, buildings, roads }) {
  const w = new Writer();
  let nTall = 0;
  for (const b of buildings) if (b.height >= 40) nTall++;
  for (const c of MAGIC_TILE) w.u8(c);
  w.u16(TILE_VERSION); w.u8(tx); w.u8(ty);
  w.u32(buildings.length); w.u16(nTall); w.u16(roads.length);
  for (const b of buildings) {
    w.u16(Math.min(65535, Math.round(b.height * 10)));
    w.u16(Math.min(65535, Math.round((b.minHeight || 0) * 10)));
    w.u8((b.heightSrc & 3) | ((b.kind & 7) << 2) | (b.tierB ? 32 : 0) | (b.isPart ? 64 : 0));
    w.u8(b.seed & 255);
    w.u8(b.rings.length);
    for (const r of b.rings) {
      const n = r.length / 2;
      w.u8(n);
      for (let i = 0; i < r.length; i++) w.i16(clampI16(r[i] * 10));
    }
  }
  for (const r of roads) {
    const n = r.pts.length / 2;
    w.u8(r.cls); w.u8(r.lanes); w.u8(r.flags); w.i8(r.layer); w.u16(n);
    for (let i = 0; i < r.pts.length; i++) w.i16(clampI16(r.pts[i] * 10));
  }
  return w.bytes();
}

export function decodeTile(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let i = 0; i < 4; i++) if (u8[i] !== MAGIC_TILE[i]) throw new Error('bad tile magic');
  const version = dv.getUint16(4, true);
  if (version !== TILE_VERSION) throw new Error('unsupported tile version ' + version);
  const tx = u8[6], ty = u8[7];
  const nB = dv.getUint32(8, true), nTall = dv.getUint16(12, true), nR = dv.getUint16(14, true);
  let p = 16;
  const buildings = new Array(nB);
  for (let i = 0; i < nB; i++) {
    const height = dv.getUint16(p, true) / 10, minHeight = dv.getUint16(p + 2, true) / 10;
    const flags = u8[p + 4], seed = u8[p + 5], nRings = u8[p + 6];
    p += 7;
    const rings = [];
    for (let k = 0; k < nRings; k++) {
      const n = u8[p++]; const r = new Float32Array(n * 2);
      for (let j = 0; j < n * 2; j++, p += 2) r[j] = dv.getInt16(p, true) / 10;
      rings.push(r);
    }
    buildings[i] = { height, minHeight, heightSrc: flags & 3, kind: (flags >> 2) & 7, tierB: !!(flags & 32), isPart: !!(flags & 64), seed, rings };
  }
  const roads = new Array(nR);
  for (let i = 0; i < nR; i++) {
    const cls = u8[p], lanes = u8[p + 1], flags = u8[p + 2], layer = dv.getInt8(p + 3), n = dv.getUint16(p + 4, true);
    p += 6;
    const pts = new Float32Array(n * 2);
    for (let j = 0; j < n * 2; j++, p += 2) pts[j] = dv.getInt16(p, true) / 10;
    roads[i] = { cls, lanes, flags, layer, pts };
  }
  return { tx, ty, nTall, buildings, roads };
}

/** land.bin. polys: [{ kind 0 land|1 green|2 beach, rings: [[x,y,...] global metres]}] */
export function encodeLand(polys) {
  const w = new Writer();
  for (const c of MAGIC_LAND) w.u8(c);
  w.u16(LAND_VERSION); w.u16(polys.length);
  for (const p of polys) {
    w.u8(p.kind); w.u8(p.rings.length);
    for (const r of p.rings) {
      w.u32(r.length / 2);
      for (let i = 0; i < r.length; i++) w.i32(Math.round(r[i] * 10));
    }
  }
  return w.bytes();
}

export function decodeLand(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let i = 0; i < 4; i++) if (u8[i] !== MAGIC_LAND[i]) throw new Error('bad land magic');
  if (dv.getUint16(4, true) !== LAND_VERSION) throw new Error('unsupported land version');
  const nP = dv.getUint16(6, true); let p = 8;
  const polys = [];
  for (let i = 0; i < nP; i++) {
    const kind = u8[p], nR = u8[p + 1]; p += 2;
    const rings = [];
    for (let k = 0; k < nR; k++) {
      const n = dv.getUint32(p, true); p += 4;
      const r = new Float32Array(n * 2);
      for (let j = 0; j < n * 2; j++, p += 4) r[j] = dv.getInt32(p, true) / 10;
      rings.push(r);
    }
    polys.push({ kind, rings });
  }
  return polys;
}

// ---- self-test: node src/shared/format.js --test ----
const isMain = typeof process !== 'undefined' && process.argv.includes('--test') && /format.js$/.test(process.argv[1] ?? '');
if (isMain) {
  const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  const near = (a, b, e) => Math.abs(a - b) <= e;
  const tile = {
    tx: 7, ty: 9,
    buildings: [
      { height: 828.4, minHeight: 0, heightSrc: 2, kind: 1, tierB: false, isPart: false, seed: 200, rings: [[0, 0, 50.3, 0, 50.3, 40.1, 0, 40.1], [10, 10, 10, 20, 20, 20]] },
      { height: 8, minHeight: 2.5, heightSrc: 3, kind: 3, tierB: true, isPart: true, seed: 3, rings: [[-3000, -3000, -2900, -3000, -2900, -2950]] },
    ],
    roads: [{ cls: 0, lanes: 4, flags: 5, layer: -1, pts: [0, 0, 100.5, 200.2, 3276, -3276] }],
  };
  const d = decodeTile(encodeTile(tile));
  assert(d.tx === 7 && d.ty === 9 && d.nTall === 1, 'header');
  assert(d.buildings.length === 2 && d.roads.length === 1, 'counts');
  const b0 = d.buildings[0], b1 = d.buildings[1];
  assert(near(b0.height, 828.4, 0.05) && b0.heightSrc === 2 && b0.kind === 1 && !b0.tierB && !b0.isPart && b0.seed === 200, 'b0 fields');
  assert(b0.rings.length === 2 && near(b0.rings[0][2], 50.3, 0.05) && near(b0.rings[1][5], 20, 0.05), 'b0 rings');
  assert(near(b1.minHeight, 2.5, 0.05) && b1.tierB && b1.isPart && b1.kind === 3 && b1.heightSrc === 3, 'b1 fields');
  const r = d.roads[0];
  assert(r.cls === 0 && r.lanes === 4 && r.flags === 5 && r.layer === -1 && near(r.pts[3], 200.2, 0.05) && near(r.pts[4], 3276, 0.05), 'road');
  const land = [{ kind: 0, rings: [[-12000, -12000, 12000, -12000, 12000, 12000.5], [0, 0, 10, 0, 10, 10]] }, { kind: 2, rings: [[1, 2, 3, 4, 5, 6]] }];
  const dl = decodeLand(encodeLand(land));
  assert(dl.length === 2 && dl[0].rings.length === 2 && dl[1].kind === 2 && near(dl[0].rings[0][5], 12000.5, 0.05), 'land');
  console.log('format.js round-trip OK');
}
