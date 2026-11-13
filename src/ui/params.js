// URL parameters. Read once at start.
//   ?t=0..1                  time of day (0 noon, 1 night)
//   ?cam=x,y,z,tx,ty,tz      camera and look-at target, scene metres (x east, y up, z = -north)
//   ?notour                  do not play the tour
//   ?q=low|high              starting quality
//   ?perf                    show the performance overlay
// A parameter that sets the view (t or cam) also skips the tour. Bad values are ignored.

export function parseParams(search = location.search) {
  const p = new URLSearchParams(search);
  const out = { perf: p.has('perf'), t: null, cam: null, q: null, tour: !p.has('notour') };

  if (p.has('t')) {
    const t = Number(p.get('t'));
    if (p.get('t') !== '' && Number.isFinite(t)) out.t = Math.min(1, Math.max(0, t));
  }
  if (p.has('cam')) {
    const v = p.get('cam').split(',').map((s) => (s.trim() === '' ? NaN : Number(s)));
    if (v.length === 6 && v.every(Number.isFinite)) out.cam = { position: v.slice(0, 3), target: v.slice(3, 6) };
  }
  const q = (p.get('q') || '').toLowerCase();
  if (q === 'low' || q === 'high') out.q = q;

  if (out.t !== null || out.cam) out.tour = false;
  return out;
}
