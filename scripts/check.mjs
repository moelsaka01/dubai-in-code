// Checks that need no browser: `npm run check`.
//   1. every landmark mesh has finite values and faces outward, and stays inside its triangle budget
//   2. the tile worker meshes all tiles and the land without errors (run in Node with a stubbed `self` and `fetch`)
//   3. the tour path keeps clear of every building of 60 m or more and of the landmarks
// Exits 1 if any check fails. Run it after touching src/landmarks, src/data or src/camera/tour.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const failures = [];
const fail = (msg) => { failures.push(msg); console.log('  FAIL', msg); };

// ---- 1. landmarks ----
const LANDMARK_TRIANGLES = 15000;
const { createEnv } = await imp('src/env/timeOfDay.js');
const env = createEnv();
function meshStats(geo) {
  const p = geo.getAttribute('position').array, n = geo.getAttribute('normal').array, idx = geo.index.array;
  let bad = 0, agree = 0, solid = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i])) bad++;
    const k = i % 3;
    if (p[i] < min[k]) min[k] = p[i];
    if (p[i] > max[k]) max[k] = p[i];
  }
  for (let i = 0; i < n.length; i++) if (!Number.isFinite(n[i])) bad++;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (Math.hypot(fx, fy, fz) < 1e-6) continue; // degenerate (poles, doubled points)
    solid++;
    // Does the face agree with the stored vertex normals?
    if (fx * (n[a] + n[b] + n[c]) + fy * (n[a + 1] + n[b + 1] + n[c + 1]) + fz * (n[a + 2] + n[b + 2] + n[c + 2]) > 0) agree++;
  }
  return { tris: idx.length / 3, bad, agree, solid, top: +max[1].toFixed(1) };
}
console.log('Landmarks');
for (const name of ['burjKhalifa', 'ainDubai', 'cayan', 'burjAlArab', 'museumFuture']) {
  const lm = (await imp(`src/landmarks/${name}.js`)).create(env);
  let calls = 0, tris = 0, top = 0;
  lm.group.traverse((o) => {
    if (!o.geometry) return;
    calls++;
    if (o.isLineSegments) return;
    const s = meshStats(o.geometry);
    tris += s.tris * (o.isInstancedMesh ? o.count : 1);
    top = Math.max(top, s.top + o.position.y);
    if (s.bad) fail(`${name}: ${s.bad} non-finite values`);
    if (s.agree < s.solid * 0.97) fail(`${name}: only ${s.agree} of ${s.solid} faces agree with their normals`);
  });
  lm.update(0.016, env);
  console.log(`  ${name}: ${calls} draw calls, ${tris} triangles, top of mesh ${top.toFixed(0)} m`);
  if (tris > LANDMARK_TRIANGLES) fail(`${name}: ${tris} triangles, budget ${LANDMARK_TRIANGLES}`);
  if (calls > 4) fail(`${name}: ${calls} draw calls, budget 4`);
}

// ---- 2. the tile worker on the real data ----
const { decodeTile } = await imp('src/shared/format.js');
const out = [];
globalThis.self = { postMessage: (m) => out.push(m) };
globalThis.fetch = async (file) => ({ ok: true, arrayBuffer: async () => { const b = fs.readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
await imp('src/data/tileWorker.js');
const bridgesFile = path.join(root, 'public/data/bridges.json');
if (!fs.existsSync(bridgesFile)) fail('public/data/bridges.json is missing: run npm run data:bridges');
else await globalThis.self.onmessage({ data: { type: 'bridges', nodes: JSON.parse(fs.readFileSync(bridgesFile, 'utf8')).nodes } });
const tilesDir = path.join(root, 'public/data/tiles');
const files = fs.readdirSync(tilesDir);
let verts = 0, tris = 0, roadTris = 0, lights = 0, beacons = 0, palms = 0, trees = 0, cars = 0, maxTris = 0;
const t0 = Date.now();
for (const f of files) {
  await globalThis.self.onmessage({ data: { type: 'tile', id: f, url: path.join(tilesDir, f) } });
  const m = out.pop();
  if (m.type === 'error') { fail(`tile ${f}: ${m.message}`); continue; }
  const b = m.buildings;
  for (const k of ['position', 'uv']) for (const v of b[k]) if (!Number.isFinite(v)) { fail(`tile ${f}: non-finite ${k}`); break; }
  if (!(b.tallIndexCount <= b.bodyIndexCount && b.bodyIndexCount <= b.index.length)) fail(`tile ${f}: index ranges out of order`);
  verts += b.position.length / 3;
  tris += b.index.length / 3;
  maxTris = Math.max(maxTris, b.index.length / 3);
  roadTris += m.roads.index.length / 3;
  lights += m.roads.lights.length / 3;
  beacons += b.beacons.length / 3;
  palms += m.props.palms.length / 4;
  trees += m.props.trees.length / 4;
  cars += m.props.cars.length / 4;
}
console.log(`Tiles: ${files.length} meshed in ${Date.now() - t0} ms`);
console.log(`  buildings ${verts} vertices, ${tris} triangles (largest tile ${maxTris}); roads ${roadTris} triangles`);
console.log(`  street lights ${lights}, beacons ${beacons}, palms ${palms}, garden trees ${trees}, street cars ${cars}`);
await globalThis.self.onmessage({ data: { type: 'land', id: 'land', url: path.join(root, 'public/data/land.bin') } });
const land = out.pop();
if (land.type === 'error') fail(`land: ${land.message}`);
else {
  for (const k of ['land', 'cover']) {
    const p = land[k].position, idx = land[k].index;
    let down = 0, area = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ny = (p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
      if (ny < -1e-3) down++; else area += ny / 2;
    }
    console.log(`  ${k}: ${idx.length / 3} triangles, top area ${(area / 1e6).toFixed(1)} km2, park trees ${k === 'cover' ? (land.props.trees.length + land.props.palms.length) / 4 : '-'}`);
    if (down) fail(`${k}: ${down} triangles face down`);
  }
}

// ---- 3. tour clearance ----
const { tourPose, TOUR_SECONDS } = await imp('src/camera/tour.js');
const { TILE_SIZE, GRID_MIN, LANDMARKS, project } = await imp('src/shared/config.js');
const boxes = [];
for (const f of files) {
  const tile = decodeTile(fs.readFileSync(path.join(tilesDir, f)));
  const e0 = GRID_MIN + tile.tx * TILE_SIZE, n0 = GRID_MIN + tile.ty * TILE_SIZE;
  for (const b of tile.buildings) {
    if (b.height < 60) continue;
    const r = b.rings[0];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
    boxes.push([e0 + x0, e0 + x1, n0 + y0, n0 + y1, b.height + 50]); // + 50 m: crowns and masts stand above the tagged height
  }
}
const marks = Object.values(LANDMARKS).map((l) => [...project(l.lat, l.lon), l.clear + 20, l.height]);
const MARGIN = 25;
let hits = 0, prev = null, maxSpeed = 0, minY = Infinity;
for (let s = 0; s <= TOUR_SECONDS; s += 0.05) {
  const c = tourPose(s).position;
  const e = c.x, n = -c.z, y = c.y;
  minY = Math.min(minY, y);
  if (prev) maxSpeed = Math.max(maxSpeed, Math.hypot(e - prev[0], n - prev[1], y - prev[2]) / 0.05);
  prev = [e, n, y];
  for (const b of boxes) if (e > b[0] - MARGIN && e < b[1] + MARGIN && n > b[2] - MARGIN && n < b[3] + MARGIN && y < b[4]) { hits++; if (hits <= 5) console.log(`  near a ${b[4] - 50} m building at ${s.toFixed(2)} s (${e.toFixed(0)}, ${n.toFixed(0)}, y ${y.toFixed(0)})`); }
  for (const l of marks) if (Math.hypot(e - l[0], n - l[1]) < l[2] && y < l[3]) { hits++; if (hits <= 5) console.log(`  inside a landmark's clear radius at ${s.toFixed(2)} s`); }
}
console.log(`Tour: ${TOUR_SECONDS} s, lowest point ${minY.toFixed(0)} m, top speed ${maxSpeed.toFixed(0)} m/s`);
if (hits) fail(`tour passes within ${MARGIN} m of a building or landmark at ${hits} samples`);

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
