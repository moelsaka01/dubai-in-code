// Bridge heights. OSM says which ways are bridges and on which layer, not how high they are, so the height is
// made up from the shape of the bridge network: every point on a bridge knows how far it is, along bridges, from
// the nearest place where a bridge meets the ground, and the deck rises with that distance.
//
// A tile only holds its own ways, and a bridge is usually several ways, often in two tiles. So the distances
// are worked out once for the whole city (`bridgeTable`, run by scripts/build-bridges.mjs) and shipped as
// public/data/bridges.json; the tile worker and the traffic read heights from it (`liftOf`).
// Plain ES module, used by Node and the browser.

export const RAMP = 70; // metres of bridge it takes to reach full height

/** Full deck height for a way of this class on this OSM layer. The Metro runs higher than the roads. */
export function deckHeight(cls, layer) {
  return (cls === 7 ? 9 : 6) + Math.max(0, layer - 1) * 5;
}

/** A way is drawn raised when it is a bridge and not also a tunnel. */
export const isRaised = (r) => (r.flags & 1) !== 0 && (r.flags & 2) === 0;

/** Node key: bridge ends are matched on a 1 m grid of global (east, north). */
export const nodeKey = (east, north) => `${Math.round(east)}_${Math.round(north)}`;

const ease = (t) => { const k = Math.min(1, Math.max(0, t)); return k * k * (3 - 2 * k); };

/**
 * Height above the road's base at `s` metres along a raised way of length `total`.
 * dStart, dEnd: distance from each end to the ground (0 for an end that meets the ground).
 * reach: the largest distance to the ground anywhere on this bridge. top: its full deck height.
 */
export function liftOf(s, total, dStart, dEnd, reach, top) {
  const d = Math.min(dStart + s, dEnd + total - s);
  const peak = Math.min(top, reach * 0.16); // a short bridge is a hump, not a tower
  return peak * ease(d / Math.min(RAMP, Math.max(reach, 1)));
}

/**
 * @param {{ cls: number, layer: number, pts: number[] }[]} ways raised ways with global (east, north) points
 * @returns {{ nodes: Map<string, [number, number, number]> }} per joined end node: distance to ground, reach, top
 */
export function bridgeTable(ways) {
  const nodes = new Map(); // key -> { edges: [], d, comp }
  const node = (k) => { let n = nodes.get(k); if (!n) nodes.set(k, n = { key: k, edges: [], d: Infinity, parent: null }); return n; };
  const edges = [];
  for (const w of ways) {
    const p = w.pts, n = p.length;
    let len = 0;
    for (let i = 2; i < n; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    const a = node(nodeKey(p[0], p[1])), b = node(nodeKey(p[n - 2], p[n - 1]));
    const e = { a, b, len, top: deckHeight(w.cls, w.layer) };
    edges.push(e);
    a.edges.push(e);
    b.edges.push(e);
  }
  // Distance to the ground: every free end is ground. Dijkstra from all of them at once.
  const open = [];
  for (const n of nodes.values()) if (n.edges.length === 1) { n.d = 0; open.push(n); }
  while (open.length) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i].d < open[best].d) best = i;
    const n = open.splice(best, 1)[0];
    for (const e of n.edges) {
      const o = e.a === n ? e.b : e.a;
      if (n.d + e.len < o.d) {
        if (o.d === Infinity) open.push(o);
        o.d = n.d + e.len;
      }
    }
  }
  // Connected bridges share one reach and one deck height, so they meet without a step.
  const find = (n) => { while (n.parent) n = n.parent; return n; };
  for (const e of edges) {
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) rb.parent = ra;
  }
  const comps = new Map();
  for (const e of edges) {
    const root = find(e.a);
    let c = comps.get(root);
    if (!c) comps.set(root, c = { reach: 0, top: 0 });
    const da = Math.min(e.a.d, 1e5), db = Math.min(e.b.d, 1e5);
    c.reach = Math.max(c.reach, (da + db + e.len) / 2); // the point on this way farthest from the ground
    c.top = Math.max(c.top, e.top);
  }
  const out = new Map();
  for (const n of nodes.values()) {
    if (n.edges.length < 2) continue;
    const c = comps.get(find(n));
    out.set(n.key, [Math.round(Math.min(n.d, 1e5) * 10) / 10, Math.round(c.reach * 10) / 10, c.top]);
  }
  return { nodes: out };
}
