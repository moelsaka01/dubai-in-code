// Task 2.7: heights (tag > levels > overrides > zone estimate), kind classification, seed.
import { readFileSync } from 'node:fs';
import { project } from '../../src/shared/config.js';
import { distToPolyline } from './geom.mjs';

export const LEVEL_M = 3.2;
export const ESTIMATE_CAP_M = 260;
export const SRC = { TAG: 0, LEVELS: 1, OVERRIDE: 2, ESTIMATE: 3 };

/** "123", "123 m", "12.5m", "40 ft", "40'" -> metres, or null. */
export function parseHeight(v) {
  if (v == null) return null;
  const m = String(v).trim().toLowerCase().replace(',', '.').match(/^(-?\d+(?:\.\d+)?)\s*(m|ft|feet|')?$/);
  if (!m) return null;
  let h = parseFloat(m[1]);
  if (m[2] === 'ft' || m[2] === 'feet' || m[2] === "'") h *= 0.3048;
  return h > 0 && h < 1000 ? h : null;
}
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

/** Deterministic hash of an OSM id string -> [0,1). */
export function hash01(id, salt = 0) {
  let h = 2166136261 ^ salt;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13; h = Math.imul(h, 3266489917); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
export function loadOverrides(path) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const byName = new Map(Object.entries(j.byName || {}).map(([k, v]) => [norm(k), v]));
  const byId = new Map(Object.entries(j.byId || {}).map(([k, v]) => [String(k), v]));
  return { byName, byId, used: new Set() };
}

const LOW_TYPES = new Set(['house', 'villa', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'garage', 'garages', 'carport', 'roof', 'canopy', 'shed', 'hut', 'cabin', 'kiosk', 'static_caravan']);
const PODIUM_TYPES = new Set(['retail', 'commercial', 'supermarket', 'mall', 'parking', 'industrial', 'warehouse', 'factory', 'service', 'school', 'hospital', 'university', 'college', 'mosque', 'church', 'temple', 'religious', 'civic', 'public', 'government', 'stadium', 'sports_hall', 'hangar', 'train_station', 'transportation', 'airport_terminal']);

// Palm Jumeirah trunk axis (metres): foot = southernmost vertex of the Palm land polygon (25.1018, 55.1480), crown centre = mean of its vertices
// (25.1180, 55.1336), ~2.3 km NW. Derived from the built land.bin in Phase 2. Trunk = within 350 m.
const PALM_AXIS = [...project(25.1018, 55.1480), ...project(25.1180, 55.1336)];

const lerp = (a, b, u) => a + (b - a) * u;
const skewLow = (u) => u * u;

/** Zone-table estimate, PLAN.md section 2 step 4. */
export function estimate(b) {
  const t = b.tags.building || (b.isPart ? 'yes' : 'yes');
  const u = hash01(b.id, 1), u2 = hash01(b.id, 2);
  const A = b.area;
  const low = LOW_TYPES.has(t);
  const podiumType = PODIUM_TYPES.has(t);
  let h;
  switch (b.zone) {
    case 'marina':
    case 'downtown': {
      const marina = b.zone === 'marina';
      if (low) h = lerp(3.5, 9, u);
      else if (podiumType || A > 3000) h = marina ? lerp(12, 25, u) : lerp(15, 30, u);
      else if (A < 300) h = marina ? lerp(6, 10, u) : lerp(8, 15, u);
      else {
        // PLAN table range, but the top of the range needs a big footprint: first pass gave ~450 fake towers >= 150 m (real: ~200 in these zones)
        const reach = Math.max(0.25, Math.min(1, (A - 300) / 1500));
        const [lo, hi] = marina ? [90, 260] : [60, 220];
        h = lerp(lo, lo + (hi - lo) * reach, skewLow(u));
      }
      
      break;
    }
    case 'szr':
      if (low) h = lerp(4, 9, u);
      else if (podiumType || A > 3000) h = lerp(12, 20, u);
      else if (A >= 300) h = lerp(20, 60, skewLow(u));
      else h = lerp(8, 12, u);
      break;
    case 'palm': {
      const trunk = distToPolyline(b.cx, b.cy, PALM_AXIS) <= 350;
      if (low) h = lerp(6, 9, u);
      else if (trunk) h = A > 3000 ? lerp(20, 30, u) : A >= 300 ? lerp(30, 50, u) : 9;
      else if (A > 1500) h = lerp(25, 60, skewLow(u));
      else h = A >= 200 ? 9 : lerp(7, 9, u2);
      break;
    }
    case 'baa':
      if (low) h = lerp(5, 9, u);
      else if (A > 3000) h = lerp(15, 25, u);
      else if (A >= 300) h = lerp(12, 30, u);
      else h = lerp(7, 9, u);
      break;
    default: // context
      if (low) h = lerp(4, 8, u);
      else if (t === 'apartments' || t === 'residential' && A > 600) h = A >= 300 ? lerp(15, 30, u) : lerp(9, 14, u);
      else if (A > 3000) h = lerp(9, 14, u);
      else if (A >= 300) h = lerp(7, 12, u);
      else h = 7;
  }
  return Math.min(h, ESTIMATE_CAP_M);
}

export function classify(b, height) {
  const t = b.tags.building || 'yes';
  if (['roof', 'canopy', 'carport', 'garage', 'garages', 'shed', 'hut', 'kiosk'].includes(t)) return 7;
  if (['mosque', 'church', 'temple', 'religious', 'civic', 'public', 'government', 'school', 'hospital', 'university', 'college', 'stadium'].includes(t)) return 6;
  if (height >= 60) return 1;
  if (['house', 'villa', 'detached', 'semidetached_house', 'terrace', 'bungalow'].includes(t)) return 3;
  if (['apartments', 'residential', 'dormitory', 'hotel'].includes(t)) return 2;
  if (['industrial', 'warehouse', 'factory', 'service', 'hangar', 'storage_tank'].includes(t)) return 4;
  if (['retail', 'commercial', 'supermarket', 'mall', 'parking'].includes(t)) return 5;
  if (b.zone === 'palm' && b.area < 1500 && height <= 10) return 3;
  return 0;
}

/** Sets b.height, b.minHeight, b.heightSrc, b.kind, b.seed, b.overrideKey on every building. */
export function applyHeights(buildings, overrides) {
  for (const b of buildings) {
    const tg = b.tags;
    let h = parseHeight(tg.height) ?? parseHeight(tg['building:height']);
    let src = SRC.TAG;
    if (h == null) {
      const lv = num(tg['building:levels']);
      if (lv != null && lv > 0 && lv < 250) {
        h = lv * LEVEL_M + (num(tg['roof:levels']) || 0) * 2;
        src = SRC.LEVELS;
      }
    }
    if (h == null) {
      const ov = overrides.byId.get(b.id) ?? overrides.byId.get(b.id.slice(1)) ?? (tg.name ? overrides.byName.get(norm(tg.name)) : undefined)
        ?? (tg['name:en'] ? overrides.byName.get(norm(tg['name:en'])) : undefined);
      if (ov != null) { h = ov; src = SRC.OVERRIDE; overrides.used.add(tg.name || b.id); }
    }
    if (h == null) { h = estimate(b); src = SRC.ESTIMATE; }
    // min height for parts
    let minH = 0;
    if (b.isPart) {
      minH = parseHeight(tg.min_height) ?? (num(tg['building:min_level']) != null ? num(tg['building:min_level']) * LEVEL_M : 0);
      if (minH >= h) minH = 0;
    }
    b.height = Math.max(2.5, h);
    b.minHeight = minH;
    b.heightSrc = src;
    b.kind = classify(b, b.height);
    b.seed = Math.floor(hash01(b.id, 3) * 256);
  }
}
