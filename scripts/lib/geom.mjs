// Geometry helpers. Rings are flat arrays [x0,y0,x1,y1,...], NOT closed (last point != first).
// Metres, y = north. Positive signed area = counter-clockwise.

export function signedArea(r) {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
  return a / 2;
}
export const area = (r) => Math.abs(signedArea(r));

export function centroid(r) {
  const n = r.length / 2;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
    a += f;
    cx += (r[j * 2] + r[i * 2]) * f;
    cy += (r[j * 2 + 1] + r[i * 2 + 1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += r[i * 2]; sy += r[i * 2 + 1]; }
    return [sx / n, sy / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function bbox(r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < x0) x0 = r[i];
    if (r[i] > x1) x1 = r[i];
    if (r[i + 1] < y0) y0 = r[i + 1];
    if (r[i + 1] > y1) y1 = r[i + 1];
  }
  return [x0, y0, x1, y1];
}

export function reverseRing(r) {
  const out = new Array(r.length);
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    out[i * 2] = r[(n - 1 - i) * 2];
    out[i * 2 + 1] = r[(n - 1 - i) * 2 + 1];
  }
  return out;
}

/** Return ring with requested orientation (ccw = true for CCW). */
export function orient(r, ccw) {
  return (signedArea(r) > 0) === ccw ? r : reverseRing(r);
}

/** Drop the closing duplicate point and consecutive duplicates. */
export function openRing(r) {
  const out = [];
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const x = r[i * 2], y = r[i * 2 + 1];
    const m = out.length;
    if (m && Math.abs(out[m - 2] - x) < 1e-6 && Math.abs(out[m - 1] - y) < 1e-6) continue;
    out.push(x, y);
  }
  while (out.length > 4 && Math.abs(out[0] - out[out.length - 2]) < 1e-6 && Math.abs(out[1] - out[out.length - 1]) < 1e-6) out.length -= 2;
  return out;
}

function sqSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return x * x + y * y;
}

/** Douglas-Peucker on an open polyline (flat array). Endpoints are kept. */
export function simplifyLine(pts, tol) {
  const n = pts.length / 2;
  if (n <= 2 || tol <= 0) return Array.from(pts);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const t2 = tol * tol;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = sqSegDist(pts[i * 2], pts[i * 2 + 1], pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1]);
      if (d > md) { md = d; mi = i; }
    }
    if (mi >= 0 && md > t2) { keep[mi] = 1; stack.push(a, mi, mi, b); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

/** Simplify a closed ring (not closed in storage). Returns null if it collapses below 3 points. */
export function simplifyRing(r, tol) {
  const n = r.length / 2;
  if (n <= 4 || tol <= 0) return Array.from(r);
  let fi = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (r[i * 2] - r[0]) ** 2 + (r[i * 2 + 1] - r[1]) ** 2;
    if (d > fd) { fd = d; fi = i; }
  }
  const a = simplifyLine(Array.from(r).slice(0, (fi + 1) * 2), tol);
  const bpts = Array.from(r).slice(fi * 2);
  bpts.push(r[0], r[1]);
  const b = simplifyLine(bpts, tol);
  const out = a.concat(b.slice(2, b.length - 2));
  return out.length >= 6 ? out : null;
}

/** Point in ring (even-odd). */
export function pointInRing(x, y, r) {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2], yi = r[i * 2 + 1], xj = r[j * 2], yj = r[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in polygon with holes: rings[0] outer, rest holes. */
export function pointInPoly(x, y, rings) {
  if (!pointInRing(x, y, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(x, y, rings[k])) return false;
  return true;
}

export function convexHull(r) {
  const n = r.length / 2;
  const p = [];
  for (let i = 0; i < n; i++) p.push([r[i * 2], r[i * 2 + 1]]);
  p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop();
  up.pop();
  return lo.concat(up);
}

/** Minimum-area bounding rectangle. angle = direction of the long side from +x, in [0, PI). */
export function minAreaRect(r) {
  const h = convexHull(r);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of h) {
      const x = q[0] * c - q[1] * s, y = q[0] * s + q[1] * c;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const A = (x1 - x0) * (y1 - y0);
    if (!best || A < best.A) best = { A, ang, x0, x1, y0, y1 };
  }
  if (!best) return { angle: 0, length: 0, width: 0, cx: 0, cy: 0 };
  let ang = best.ang;
  let L = best.x1 - best.x0, W = best.y1 - best.y0;
  if (W > L) { [L, W] = [W, L]; ang += Math.PI / 2; }
  const mx = (best.x0 + best.x1) / 2, my = (best.y0 + best.y1) / 2;
  const c = Math.cos(best.ang), s = Math.sin(best.ang);
  const cx = mx * c - my * s, cy = mx * s + my * c;
  ang = ((ang % Math.PI) + Math.PI) % Math.PI;
  return { angle: ang, length: L, width: W, cx, cy };
}

/** Distance from point to polyline (flat). */
export function distToPolyline(x, y, pts) {
  let m = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const d = sqSegDist(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
    if (d < m) m = d;
  }
  return Math.sqrt(m);
}

/**
 * Stitch fragments into chains by shared end nodes.
 * segs: [{ pts: flat array, a: startKey, b: endKey }]. Returns [{ pts, closed }].
 */
export function stitch(segs) {
  const byEnd = new Map();
  const add = (k, i) => { let l = byEnd.get(k); if (!l) byEnd.set(k, (l = [])); l.push(i); };
  segs.forEach((s, i) => { add(s.a, i); add(s.b, i); });
  const used = new Uint8Array(segs.length);
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let pts = Array.from(segs[i].pts), head = segs[i].a, tail = segs[i].b;
    for (let grow = true; grow && head !== tail;) {
      grow = false;
      for (const j of byEnd.get(tail) || []) {
        if (used[j]) continue;
        used[j] = 1; grow = true;
        const s = segs[j];
        if (s.a === tail) { pts = pts.concat(Array.from(s.pts).slice(2)); tail = s.b; }
        else { pts = pts.concat(reverseRing(s.pts).slice(2)); tail = s.a; }
        break;
      }
      if (!grow) {
        for (const j of byEnd.get(head) || []) {
          if (used[j]) continue;
          used[j] = 1; grow = true;
          const s = segs[j];
          if (s.b === head) { pts = Array.from(s.pts).slice(0, -2).concat(pts); head = s.a; }
          else { pts = reverseRing(s.pts).slice(0, -2).concat(pts); head = s.b; }
          break;
        }
      }
    }
    out.push({ pts, closed: head === tail });
  }
  return out;
}
