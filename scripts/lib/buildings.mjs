// Task 2.5: load raw building JSON, dedupe, build polygons (incl. multipolygon relations), clean,
// assign zone/tier, clear landmark areas. All coordinates are local metres (east, north).
import { readFileSync, readdirSync } from 'node:fs';
import { project, BBOX, LANDMARKS, SZR_BUFFER_M } from '../../src/shared/config.js';
import { area, centroid, bbox, openRing, orient, pointInRing, stitch, distToPolyline } from './geom.mjs';

export const MIN_AREA_M2 = 12;

/** Project an Overpass geometry array [{lat,lon}] to a flat open ring/polyline in metres. */
export function projectGeom(geom) {
  const out = new Array(geom.length * 2);
  for (let i = 0; i < geom.length; i++) {
    const [x, y] = project(geom[i].lat, geom[i].lon);
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }
  return out;
}
const key = (g) => `${g.lat},${g.lon}`;

/** Read every JSON file in dir whose name starts with prefix; returns { elements, timestamp }. */
export function readRaw(dir, prefix) {
  const els = [];
  let ts = '';
  for (const f of readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort()) {
    const j = JSON.parse(readFileSync(dir + f, 'utf8'));
    if (j.osm3s?.timestamp_osm_base && j.osm3s.timestamp_osm_base > ts) ts = j.osm3s.timestamp_osm_base;
    for (const e of j.elements) els.push(e);
  }
  return { elements: els, timestamp: ts };
}

/** Assemble multipolygon rings from members [{role, geometry}] -> { outers: [ring], inners: [ring] }. */
export function relationRings(rel, projectFn = projectGeom) {
  const mk = (role) => rel.members
    .filter((m) => m.type === 'way' && m.geometry && m.geometry.length > 1 && (m.role === role || (role === 'outer' && m.role === '')))
    .map((m) => ({ pts: projectFn(m.geometry), a: key(m.geometry[0]), b: key(m.geometry[m.geometry.length - 1]) }));
  const closedOnly = (segs) => stitch(segs).filter((c) => c.closed).map((c) => openRing(c.pts)).filter((r) => r.length >= 6);
  return { outers: closedOnly(mk('outer')), inners: closedOnly(mk('inner')) };
}

/**
 * Returns buildings: { id, type, tags, isPart, rings:[outer ccw, holes cw...], area, cx, cy }
 * Deduped by type+id. Rings below MIN_AREA_M2 or degenerate are dropped.
 */
export function loadBuildings(dir) {
  const { elements, timestamp } = readRaw(dir, 'q1');
  const seen = new Set();
  const out = [];
  // relations fetched with `out tags geom` carry no members; the q1rel file has the real ones
  const els = elements.filter((e) => e.type !== 'relation' || e.members);
  // ways that are outer members of a building relation are drawn through the relation, not twice
  const relOuter = new Set();
  for (const e of els) if (e.type === 'relation') for (const m of e.members) if (m.type === 'way' && (m.role === 'outer' || m.role === '')) relOuter.add(m.ref);
  let memberWays = 0;
  let dupes = 0, degenerate = 0, tiny = 0;
  const push = (id, tags, rings) => {
    const outer = orient(rings[0], true);
    const a = area(outer);
    if (a < MIN_AREA_M2) { tiny++; return; }
    const holes = rings.slice(1).map((h) => orient(h, false));
    const [cx, cy] = centroid(outer);
    out.push({
      id, tags, isPart: !!tags['building:part'] && !tags.building,
      rings: [outer, ...holes], area: a - holes.reduce((s, h) => s + area(h), 0), cx, cy,
    });
  };
  for (const e of els) {
    const k = e.type + e.id;
    if (seen.has(k)) { dupes++; continue; }
    seen.add(k);
    const tags = e.tags || {};
    if (!tags.building && !tags['building:part']) continue;
    if (e.type === 'way') {
      if (relOuter.has(e.id)) { memberWays++; continue; }
      if (!e.geometry || e.geometry.length < 4) { degenerate++; continue; }
      const r = openRing(projectGeom(e.geometry));
      if (r.length < 6) { degenerate++; continue; }
      push('w' + e.id, tags, [r]);
    } else if (e.type === 'relation') {
      const { outers, inners } = relationRings(e);
      if (!outers.length) { degenerate++; continue; }
      const groups = outers.map((o) => [o]);
      for (const inner of inners) {
        const g = groups.find((gr) => pointInRing(inner[0], inner[1], gr[0]));
        if (g) g.push(inner);
      }
      groups.forEach((g, i) => push(`r${e.id}${i ? '_' + i : ''}`, tags, g));
    }
  }
  return { buildings: out, stats: { elements: elements.length, dupes, degenerate, tiny, memberWays }, timestamp };
}

const projBox = (b) => {
  const [x0, y0] = project(b[0], b[1]);
  const [x1, y1] = project(b[2], b[3]);
  return [x0, y0, x1, y1];
};
export const ZONE_BOXES = {
  palm: projBox(BBOX.palm),
  baa: projBox(BBOX.baa),
  marina: projBox(BBOX.marina),
  downtown: projBox(BBOX.downtown),
};
export const WORLD_BOX = projBox(BBOX.world);
const inBox = (x, y, b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/** Sets b.zone ('palm'|'baa'|'marina'|'downtown'|'szr'|'context') and b.tierA. szrLines: array of flat polylines (metres). */
export function assignZones(buildings, szrLines) {
  const lineBoxes = szrLines.map((l) => { const b = bbox(l); return [b[0] - SZR_BUFFER_M, b[1] - SZR_BUFFER_M, b[2] + SZR_BUFFER_M, b[3] + SZR_BUFFER_M]; });
  for (const b of buildings) {
    let zone = 'context';
    for (const z of ['palm', 'baa', 'marina', 'downtown']) if (inBox(b.cx, b.cy, ZONE_BOXES[z])) { zone = z; break; }
    if (zone === 'context') {
      for (let i = 0; i < szrLines.length; i++) {
        if (inBox(b.cx, b.cy, lineBoxes[i]) && distToPolyline(b.cx, b.cy, szrLines[i]) <= SZR_BUFFER_M) { zone = 'szr'; break; }
      }
    }
    b.zone = zone;
    b.tierA = zone !== 'context';
  }
}

/** Find footprint info for landmarks, then drop buildings inside clear radii. Returns { buildings, info }. */
export function clearLandmarks(buildings) {
  const info = {};
  const keep = [];
  const lms = Object.entries(LANDMARKS).map(([k, l]) => ({ k, l, p: project(l.lat, l.lon) }));
  for (const { k } of lms) info[k] = { dropped: [], footprint: null };
  for (const b of buildings) {
    let dropped = false;
    for (const { k, l, p } of lms) {
      if (Math.hypot(b.cx - p[0], b.cy - p[1]) <= l.clear) {
        info[k].dropped.push(b.id);
        const wantId = l.osm ? 'w' + l.osm.split('/')[1] : null;
        const f = info[k].footprint;
        const isTarget = wantId && b.id === wantId;
        // keep the explicit OSM way if known, else the largest outline within the clear radius
        if (isTarget || (!f?.explicit && (!f || b.area > f.area))) {
          info[k].footprint = { id: b.id, area: b.area, ring: b.rings[0], explicit: !!isTarget };
        }
        dropped = true;
      }
    }
    if (!dropped) keep.push(b);
  }
  return { buildings: keep, info };
}

